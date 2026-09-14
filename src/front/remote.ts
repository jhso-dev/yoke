// The team path: one CLI, talking to `yoke serve` instead of opening a database.
//
// `YOKE_SERVER` is what splits the two deployments, and it is the ONLY thing a developer configures.
// Without it the CLI opens a local sqlite and asks for nothing (invariant 4). With it, every action
// goes over HTTP under a credential this module acquires WITHOUT ASKING — the developer is already
// logged into `gh`, and that login is exchanged once for a yoke credential that is cached and
// refreshed from then on. Nobody pastes a token, and no database password ever reaches a laptop.
//
// The actor is not ours to choose here. The server reads it off the verified credential and ignores
// anything the body says, which is the whole reason a shared corpus is reachable this way and not by
// pointing the CLI at OpenSearch directly.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IngestResult } from "../connectors/ingest.js";
import type {
  MappedResult,
  RdbMappingConnector,
} from "../connectors/rdb-mapping.js";
import type { Ref, Relater } from "../connectors/relate.js";
import type { Connector, SourceItem } from "../connectors/types.js";
import type { WithheldStats } from "../core/inject.js";
import type { TypeDef } from "../core/ontology.js";
import { safeName } from "../core/persona.js";
import { describeWithheld } from "./display.js";

type Env = Record<string, string | undefined>;

/** The cache is a bearer secret, so 0600, and keyed by server: one exchange per machine covers every
 * repo pointing at the same server. Same path and shape the plugin's hook cache has always used. */
const cacheFile = (server: string, env: Env) =>
  join(
    env.YOKE_AUTH_DIR || join(env.HOME || homedir(), ".yoke"),
    `token-${createHash("sha256").update(server).digest("hex").slice(0, 16)}.json`,
  );

interface Cached {
  token?: string;
  refresh?: string;
  login?: string;
}

function readCache(server: string, env: Env): Cached {
  try {
    return JSON.parse(readFileSync(cacheFile(server, env), "utf8")) as Cached;
  } catch {
    return {};
  }
}

function writeCache(server: string, env: Env, c: Cached): void {
  const file = cacheFile(server, env);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...c, server }), { mode: 0o600 });
}

const TIMEOUT = 8000;

/** Mint from the refresh token the cache holds. Null when there is none or it has expired. */
async function fromRefresh(
  server: string,
  env: Env,
  refresh: string | undefined,
): Promise<Cached | null> {
  if (!refresh) return null;
  const res = await fetch(new URL("/api/refresh", server), {
    method: "POST",
    headers: { authorization: `Bearer ${refresh}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) return null;
  const b = (await res.json()) as { token?: string; refresh?: string };
  if (!b.token) return null;
  const next = { token: b.token, refresh: b.refresh ?? refresh };
  writeCache(server, env, next);
  return next;
}

/** Exchange the developer's existing `gh` login. The one call that needs a human to have logged in
 * to something, and they already did — this is what "no credential step" means in practice. */
async function fromGitHub(server: string, env: Env): Promise<Cached | null> {
  const gh = spawnSync(env.YOKE_GH_BIN || "gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const ghToken = gh.status === 0 ? (gh.stdout ?? "").trim() : "";
  if (!ghToken)
    throw new Error(
      `cannot authenticate to ${server}: no GitHub login on this machine — run 'gh auth login', ` +
        "or set YOKE_TOKEN to a credential from 'yoke token create'",
    );
  const res = await fetch(new URL("/api/login/github", server), {
    method: "POST",
    headers: { authorization: `Bearer ${ghToken}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    // 404 is the server saying it has no exchange to offer (no YOKE_GITHUB_ORG), which is a
    // deployment fact, not a verdict on the caller — pointing them at their GitHub account would
    // send them to fix the one thing that is fine.
    if (res.status === 404)
      throw new Error(
        `${server} does not mint credentials from GitHub (it has no YOKE_GITHUB_ORG). ` +
          "Ask its operator for one: yoke token create --name <who> --scopes <list>, then set YOKE_TOKEN",
      );
    const why = await res.text().catch(() => "");
    throw new Error(
      `${server} refused the GitHub credential (${res.status})${why ? `: ${why}` : ""}`,
    );
  }
  const b = (await res.json()) as {
    token?: string;
    refresh?: string;
    login?: string;
  };
  if (!b.token) throw new Error(`${server} returned no credential`);
  const next = { token: b.token, refresh: b.refresh, login: b.login };
  writeCache(server, env, next);
  return next;
}

export interface Remote {
  base: string;
  /** Who this caller says they are, which namespace they mean, and which store they expect. An UNGATED server takes the first two
   * (invariant 4: nothing authenticates them, and `--actor` still has to mean something on a
   * single-user store); a gated one ignores them and reads the credential instead. */
  identity: { actor?: string; ns?: string };
  /** An authenticated request. A 401 heals once — refresh, then re-exchange — before it is
   * reported, so a credential that expired overnight costs nobody a manual step. The caller's own
   * headers survive: the MCP relay sets content negotiation and a session id of its own. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The same, for the JSON routes: one call, body read. */
  call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }>;
  /**
   * The line announcing that a credential just left this machine, or "".
   *
   * Set ONLY when the GitHub exchange actually ran — not for a cache hit and not for a refresh. A
   * credential leaving a developer's machine is the kind of thing that costs trust when discovered
   * later, so it is said out loud exactly once, on the delivery that caused it.
   */
  announce(): string;
}

/**
 * The server this CLI talks to. There is always one.
 *
 * A local yoke is a `yoke serve` on loopback, ungated and asking for nothing — the same product as
 * a team's, bound narrower. Modelling "no server" was what let two implementations of every
 * operation grow: one against a store the CLI opened and one behind the routes, which then drifted.
 */
export const LOCAL_SERVER = "http://127.0.0.1:4800";

export function resolveRemote(
  env: Env,
  identity: { actor?: string; ns?: string; store?: string } = {},
): Remote {
  const base = env.YOKE_SERVER ?? LOCAL_SERVER;
  // Which store this caller MEANT, stated only when the address was a default rather than a choice.
  //
  // One port for every project on a machine: standing in project B while project A's server holds
  // 127.0.0.1:4800, a write lands in A's corpus and nothing says so — measured, and the worst thing
  // the address default can do. A caller who set YOKE_SERVER picked that server and is not guessing;
  // a caller who did not is asking for "the server for this store", and the server can say when it
  // is not that. Checked server-side so the refusal arrives BEFORE the write, not after.
  const expects = env.YOKE_SERVER ? undefined : identity.store;
  let cached: Cached | null = null;
  let minted: string | undefined;
  // An explicitly configured credential is not ours to manage: no cache, no refresh, no exchange.
  const pinned = env.YOKE_TOKEN;

  const exchange = async (): Promise<Cached | null> => {
    const c = await fromGitHub(base, env);
    if (c?.token) minted = c.login ?? "";
    return c;
  };

  /**
   * Whatever credential is already at hand, or none — this never mints.
   *
   * A loopback `yoke serve` is ungated (invariant 4), and a client that acquired one before asking
   * would make the local path demand a GitHub login to read its own store. So the request goes out
   * bare, and only a 401 — the server saying it needs a credential — pays for `renew`.
   */
  const held = (): string | undefined => {
    if (pinned) return pinned;
    if (cached?.token) return cached.token;
    const disk = readCache(base, env);
    if (disk.token) cached = disk;
    return cached?.token;
  };

  const renew = async (): Promise<string | null> => {
    if (pinned) return null;
    const disk = readCache(base, env);
    cached = (await fromRefresh(base, env, disk.refresh)) ?? (await exchange());
    return cached?.token ?? null;
  };

  return {
    base,
    identity,
    announce: () => {
      if (minted === undefined) return "";
      const who = minted;
      minted = undefined;
      return `yoke: authenticated as ${who} via GitHub — credential cached in ${env.YOKE_AUTH_DIR || "~/.yoke"}\n`;
    },
    async fetch(url, init) {
      // `Headers`, not a spread: the MCP transport passes a Headers instance, and spreading one
      // yields an empty object — which silently drops its content negotiation and session id.
      const send = (token: string | undefined) => {
        const headers = new Headers(init?.headers);
        if (token) headers.set("authorization", `Bearer ${token}`);
        if (identity.actor) headers.set("x-yoke-actor", identity.actor);
        if (identity.ns) headers.set("x-yoke-ns", identity.ns);
        if (expects) headers.set("x-yoke-store", expects);
        return globalThis.fetch(url, { ...init, headers });
      };
      const res = await send(held()).catch((e: unknown) => {
        // Nothing listening is the one failure with a single obvious remedy, and `fetch` reports it
        // as a bare "fetch failed" that names neither the address nor the fix.
        const cause = (e as { cause?: { code?: string; message?: string } })
          ?.cause;
        if (cause?.code === "ECONNREFUSED" || cause?.code === "ENOTFOUND") {
          if (env.YOKE_SERVER)
            throw new Error(
              `no yoke server at ${base} — start one with 'yoke serve', or point YOKE_SERVER at ` +
                "the one you mean",
            );
          // The default address, so the reader is standing in a project: tell them the WHOLE
          // sequence. Sending them to `yoke serve` alone is how a first run bounces twice — serve
          // then refuses an uninitialized store and they come back for the step before it.
          throw new Error(
            expects && !existsSync(expects)
              ? `no yoke here yet — run 'yoke init', then 'yoke serve' (it holds ${base} while you work)`
              : `no yoke server at ${base} — run 'yoke serve' to hold this store, or set ` +
                  "YOKE_SERVER to your team's",
          );
        }
        // Anything else still has to name the address and the cause: `fetch` on its own says
        // "fetch failed", which tells a reader neither what was unreachable nor why.
        throw new Error(
          `cannot reach ${base}: ${cause?.message ?? (e as Error).message}`,
        );
      });
      if (res.status !== 401) return res;
      const fresh = await renew();
      return fresh ? send(fresh) : res;
    },
    async call(method, path, body) {
      const res = await this.fetch(new URL(path, base).toString(), {
        method,
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

// ---------------------------------------------------------------------------
// Commands, against the server.
//
// The server's row already carries the effective status, the summary and the author's NAME — it
// computes them once per request for the browser — so a row prints here with no second read. That is
// why this is a formatter and not a second copy of the read path.

type Values = Record<string, unknown>;

/** Print the credential announce, if this call is the one that acquired it. Stdout, ahead of
 * whatever the command prints: a credential leaving the machine must never be discoverable-only. */
function said(remote: Remote): void {
  const line = remote.announce();
  if (line) process.stdout.write(line);
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

interface Row {
  id: string;
  type: string;
  effectiveStatus?: string;
  status?: string;
  summary?: string;
  actor?: string;
  actorName?: string;
}

const line = (r: Row): string =>
  [
    r.id,
    r.type,
    r.effectiveStatus ?? r.status ?? "",
    r.summary ?? "",
    r.actorName ?? r.actor ?? "",
  ]
    .filter((c) => c !== "")
    .join("  ");

function query(pairs: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) {
    if (Array.isArray(v)) for (const one of v) q.append(k, one);
    else if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Attributes from repeated `--attr k=v`, the same grammar the local path parses. */
function attrsOf(v: Values): Record<string, string> {
  const raw = v.attr;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: Record<string, string> = {};
  for (const a of list) {
    const s = String(a);
    const i = s.indexOf("=");
    if (i < 1) throw new Error(`--attr must be k=v, got: ${s}`);
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

/** Machine JSON with --json, human text otherwise. */
function emit(json: boolean, human: string, data: unknown): void {
  console.log(json ? JSON.stringify(data) : human);
}

/** The full record, the shape `yoke get` and `yoke add` have always printed. */
function formatEntity(
  e: Row & { version?: number; attributes?: unknown },
): string {
  return `${e.id}  ${e.type}  ${e.effectiveStatus ?? e.status}  v${e.version}  ${JSON.stringify(e.attributes)}`;
}

/** A record in words — a report a person acts on cannot be a list of ULIDs. */
const label = (e: Row): string => `${e.summary ?? ""}  [${e.type} ${e.id}]`;

interface Edge extends Row {
  from: string;
  to: string;
  dir: "out" | "in";
  attributes?: Record<string, unknown>;
  other: Row & { missing?: true };
}

interface Created extends Row {
  version: number;
  attributes?: unknown;
  duplicates?: { id: string }[];
  duplicateDetection?: string;
  unrecorded?: string[];
}

/**
 * Run `command` against the server, or return null when there is no server work to do.
 *
 * Null is the signal that a command is LOCAL — `init`, `serve`, `ui`, `mcp`, `token` and the file
 * commands act on a machine, not on a corpus, and no server is any help with them. The caller falls
 * through to its own switch for those, and for nothing else.
 */
export async function runRemote(
  remote: Remote,
  command: string,
  positionals: string[],
  v: Values,
): Promise<number | null> {
  const limit = str(v.limit);
  const json = v.json === true;

  const out = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; parsed: unknown; text: string }> => {
    const r = await remote.call(method, path, body);
    // Ahead of the command's own output, so it rides the same delivery the exchange paid for. Under
    // --json it goes to stderr instead: still seen by a person, never inside the parsed document.
    const said = remote.announce();
    if (said) (json ? process.stderr : process.stdout).write(said);
    if (r.status === 204) return { status: 204, parsed: null, text: "" };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      // A text/plain route (inject --unseen). The body is the answer.
    }
    if (r.status >= 400) {
      const b = parsed as { error?: string; reason?: string } | null;
      const msg = b?.error ?? r.text.trim();
      // The gate's own sentence, not an HTTP one: `rejected (ontology): …` is what a caller reads,
      // and it means the same thing whichever tier ran the gate.
      throw new Error(
        b?.reason
          ? `rejected (${b.reason}): ${msg}`
          : `${remote.base}: ${msg || `HTTP ${r.status}`}`,
      );
    }
    return { status: r.status, parsed, text: r.text };
  };

  switch (command) {
    case "add": {
      const type = positionals[0];
      if (!type) {
        console.error(
          "usage: yoke add <type> [--actor id] [--attr k=v ...] [--scope entity-id]",
        );
        return 1;
      }
      const r = await out("POST", "/api/entity", {
        type,
        attributes: attrsOf(v),
        ...(str(v.scope) ? { scope: str(v.scope) } : {}),
      });
      const b = r.parsed as Created;
      const lines = [formatEntity(b)];
      if (b.duplicates?.length)
        lines.push(
          `similar knowledge (${b.duplicates.length}): ${b.duplicates.map((d) => d.id).join(" ")}`,
        );
      // The gate returns WHY duplicates is empty: "no similar knowledge" and "nobody looked" are
      // different facts (SPEC gate stage 3), and with no embedder nothing was compared.
      else if (b.duplicateDetection === "skipped")
        lines.push(
          // No "(see README)": a notice printed by a CLI has to be actionable from the CLI.
          "no duplicate check ran: set YOKE_EMBED_URL and YOKE_EMBED_MODEL " +
            "(any OpenAI-compatible /embeddings endpoint), then: yoke backfill --embeddings",
        );
      // The record is durable and part of what was asked for is not. Saying so beats an exit 0 that
      // reads as "all of it landed" — a missing authorship edge is invisible afterwards.
      if (b.unrecorded)
        lines.push(
          `stored, but these could not be written:\n  ${b.unrecorded.join("\n  ")}\n` +
            "authorship is re-derivable with 'yoke backfill'; an attachment must be filed again",
        );
      emit(json, lines.join("\n"), b);
      return b.unrecorded ? 1 : 0;
    }

    case "link": {
      const [from, type, to] = positionals;
      if (!from || !type || !to) {
        console.error(
          "usage: yoke link <from-id> <relation> <to-id> [--actor id] [--attr k=v ...]",
        );
        return 1;
      }
      const r = await out("POST", "/api/link", {
        type,
        from,
        to,
        attributes: attrsOf(v),
      });
      emit(json, formatEntity(r.parsed as Created), r.parsed);
      return 0;
    }

    case "get": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: yoke get <id> [--version n] [--relations]");
        return 1;
      }
      const r = await out(
        "GET",
        `/api/entity/${encodeURIComponent(id)}${query({ version: str(v.version), relations: v.relations ? "1" : undefined })}`,
      );
      const b = r.parsed as {
        entity?: Created;
        retirement?: { reason?: string };
        relations?: { out: Edge[]; in: Edge[] };
      };
      const e = b.entity;
      if (!e) {
        console.error(`not found: ${id}`);
        return 1;
      }
      // A retired record raises exactly one question, and the answer is on the version that retired it.
      const head =
        b.retirement?.reason !== undefined
          ? `${formatEntity(e)}\n  retired: ${b.retirement.reason}`
          : formatEntity(e);
      if (!v.relations) {
        emit(json, head, b.retirement ? { ...e, retired: b.retirement } : e);
        return 0;
      }
      const edges = [...(b.relations?.out ?? []), ...(b.relations?.in ?? [])];
      const lines = edges.map((rel) => {
        // Named, with the id kept: the id is the copyable handle every other command takes, and a
        // record from another namespace resolves to nothing here rather than leaking its text.
        const end = rel.other.missing
          ? rel.other.id
          : `${rel.other.summary || rel.other.type}  ${rel.other.id}`;
        const said = Object.entries(rel.attributes ?? {})
          .filter(([, x]) => typeof x === "string" && x.trim())
          .map(([k, x]) => `${k}: ${x as string}`);
        return (
          `  ${rel.dir === "out" ? "->" : "<-"} ${rel.type}  ${end}` +
          said.map((x) => `\n       ${x}`).join("")
        );
      });
      emit(
        json,
        [head, lines.length ? lines.join("\n") : "  (no relations)"].join("\n"),
        {
          ...e,
          relations: edges,
          ...(b.retirement ? { retired: b.retirement } : {}),
        },
      );
      return 0;
    }

    case "list": {
      const r = await out(
        "GET",
        `/api/entities${query({ type: str(v.type), status: str(v.status), limit, after: str(v.after) })}`,
      );
      const p = r.parsed as { items: Row[]; next: string | null };
      if (p.items.length === 0) {
        emit(json, "nothing to list", p);
        return 0;
      }
      const lines = p.items.map(line);
      if (p.next) lines.push(`-- more: yoke list --after ${p.next}`);
      emit(json, lines.join("\n"), p);
      return 0;
    }

    case "search": {
      const q = positionals.join(" ");
      if (!q) {
        console.error(
          "usage: yoke search <query> [--type t] [--status s] [--limit n]\n" +
            '  quote a phrase: yoke search "retry budget"',
        );
        return 1;
      }
      const r = await out("GET", `/api/search${query({ q, limit })}`);
      const b = r.parsed as { items: Row[] };
      emit(
        json,
        b.items.length ? b.items.map(line).join("\n") : "no results",
        b.items,
      );
      return 0;
    }

    case "review": {
      const r = await out(
        "GET",
        `/api/review${query({ limit, after: str(v.after) })}`,
      );
      const b = r.parsed as {
        items: (Row & { injections: number; last_confirmed: string })[];
        next: string | null;
        scanned: number;
      };
      if (b.items.length === 0) {
        emit(json, `no stale records (scanned ${b.scanned} verified)`, []);
        return 0;
      }
      const lines = b.items.map(
        (e) =>
          `${e.id}  ${e.type}  ${e.summary}  ${e.actorName ?? e.actor}  injected ${e.injections}x  last confirmed ${e.last_confirmed}`,
      );
      // The scan is bounded, so say what it covered — "3 stale" alone reads as "3 stale in the whole
      // corpus", which is a claim this walk did not make. The injection counts carry no such caveat:
      // the ledger counts every delivery as it happens, so they are totals.
      lines.push(
        `-- ${b.items.length} stale among ${b.scanned} verified records scanned` +
          (b.next === null ? "" : `; more to scan: --after ${b.next}`),
      );
      emit(json, lines.join("\n"), b.items);
      return 0;
    }

    case "verify": {
      if (positionals.length === 0) {
        console.error("usage: yoke verify <id...> [--actor a]");
        return 1;
      }
      const r = await out("POST", "/api/verify", { ids: positionals });
      const promoted = r.parsed as Row[];
      emit(
        json,
        `re-confirmed ${promoted.length}: ${promoted.map((e) => e.id).join(" ")}`,
        promoted,
      );
      return 0;
    }

    case "deprecate": {
      if (positionals.length === 0) {
        console.error(
          'usage: yoke deprecate <id...> [--actor a] [--reason "why it was retired"]',
        );
        return 1;
      }
      const r = await out("POST", "/api/deprecate", {
        ids: positionals,
        ...(str(v.reason) ? { reason: str(v.reason) } : {}),
      });
      const b = r.parsed as { deprecated: Row[]; downstream: Row[] };
      const human = [
        `deprecated ${b.deprecated.length}: ${b.deprecated.map((e) => e.id).join(" ")}`,
      ];
      // What rests on it. Retiring a record is not a repair unless the records built on it can be
      // found, and named rather than counted — "3 records" routes nobody.
      if (b.downstream.length > 0) {
        human.push(
          `${b.downstream.length} record(s) declared they rest on this — re-examine:`,
        );
        for (const d of b.downstream) human.push(`  ${label(d)}`);
      }
      emit(json, human.join("\n"), b);
      return 0;
    }

    case "inject": {
      const q = positionals.join(" ");
      // `--unseen` asks what a working context has that THIS CLIENT was not handed yet; without an
      // anchor there is no context to ask about. It sets `since` itself from the trail, so a
      // caller's --since would be silently overruled, and --json has no shape for the two-part
      // answer (skipped: add when a script needs it — the hook that calls this wants text).
      if (v.unseen) {
        for (const [bad, why] of [
          [
            v.scope === undefined,
            "--unseen is a question about a working context: pass --scope <id>",
          ],
          [
            v.since !== undefined,
            "--unseen sets its own --since (this client's last delivery for the scope)",
          ],
          [json, "--unseen has no --json shape; drop one of the two"],
          [!!q, "--unseen is a briefing: it takes no query"],
        ] as const) {
          if (bad) {
            console.error(why);
            return 1;
          }
        }
      }
      const r = await out(
        "GET",
        `/api/inject${query({
          q: q || undefined,
          scope: str(v.scope),
          unseen: v.unseen ? "1" : undefined,
          depth: str(v.depth),
          asOf: str(v["as-of"]),
          since: str(v.since),
          limit,
        })}`,
      );
      // `--unseen` answers text/plain — `unseenReport`'s own lines, which is what the local path
      // printed too — so it passes through untouched.
      if (r.parsed === null) {
        if (r.text.trim()) console.log(r.text.trimEnd());
        return 0;
      }
      const b = r.parsed as {
        items?: (Row & {
          citation?: string;
          readableCitation?: string;
          conflictsWith?: string[];
        })[];
        omitted?: number;
        walk?: { depth: number; nodes: number; truncated?: boolean } | null;
        withheld?: WithheldStats | null;
      };
      const items = b.items ?? [];
      // The server's row carries core's citation string and the summary already — the same two
      // halves the local path joined — so the line is identical without a second read.
      const lines = items.map(
        (it) =>
          `${it.readableCitation ?? it.citation ?? it.id}  ${it.summary ?? ""}` +
          (it.conflictsWith?.length
            ? `\n  ! contradicted by ${it.conflictsWith.join(" ")} — both are recorded, neither is settled`
            : ""),
      );
      // Never a silent slice: the count goes in the human output only.
      if (b.omitted)
        lines.push(
          `-- ${items.length} of ${items.length + b.omitted} on this scope (freshest first); ` +
            "the rest are reachable by querying, or raise --limit",
        );
      if (b.walk)
        lines.push(
          `-- walked ${b.walk.depth} hop(s) from the anchor, ${b.walk.nodes} record(s) reached` +
            (b.walk.truncated
              ? "; the walk hit its node budget, so the outermost hop is incomplete"
              : ""),
        );
      // Zero hits: say why, don't imply the knowledge simply isn't there. The same sentence rides a
      // PARTIAL answer, where it matters more — the lead-in differs because the reader's next move does.
      const reasonLine = b.withheld
        ? `${items.length ? "-- also held back:" : "no verified knowledge —"} ` +
          describeWithheld(b.withheld) +
          (b.withheld.stale > 0 ? " — re-confirm with 'yoke review'" : "")
        : "no results";
      if (items.length && b.withheld) lines.push(reasonLine);
      // Under --json stdout stays the raw items array; the reason goes to stderr, where a script
      // ignores it and the person debugging the script reads it.
      if (json && b.withheld) console.error(reasonLine);
      emit(json, items.length ? lines.join("\n") : reasonLine, items);
      return 0;
    }

    case "history": {
      const id = positionals[0];
      if (!id) {
        console.error("usage: yoke history <id>");
        return 1;
      }
      const r = await out("GET", `/api/history/${encodeURIComponent(id)}`);
      const b = r.parsed as {
        versions: (Row & {
          version: number;
          last_confirmed?: string;
          reason?: string;
        })[];
      };
      // The reason rides the version that IS the retirement, so each retiring version says its own.
      const lines = b.versions.map((e) => {
        const base = `v${e.version}  ${e.status}  ${e.actorName ?? e.actor}  ${e.last_confirmed}  ${e.summary}`;
        return e.reason ? `${base}\n    reason: ${e.reason}` : base;
      });
      emit(json, lines.join("\n"), b.versions);
      return 0;
    }

    case "conflicts": {
      const r = await out("GET", `/api/conflicts${query({ limit })}`);
      const pairs = r.parsed as {
        id: string;
        from: Row & { missing?: true };
        to: Row & { missing?: true };
      }[];
      if (pairs.length === 0) {
        emit(json, "no conflicts", []);
        return 0;
      }
      const side = (e: Row & { missing?: true }) =>
        e.missing ? `${e.id} (missing)` : `${e.id} [${e.status}] ${e.summary}`;
      emit(
        json,
        pairs
          .map((p) => `${p.id}\n  ${side(p.from)}\n  <-> ${side(p.to)}`)
          .join("\n"),
        pairs,
      );
      return 0;
    }

    case "graph": {
      const r = await out(
        "GET",
        `/api/graph${query({ limit, scope: str(v.scope), depth: str(v.depth) })}`,
      );
      const b = r.parsed as {
        nodes: Row[];
        edges: (Row & { from: string; to: string })[];
        truncated?: boolean;
        limit?: number;
      };
      const lines = [
        `${b.nodes.length} nodes, ${b.edges.length} edges`,
        ...b.edges.map((e) => `  ${e.from} -${e.type}-> ${e.to}`),
      ];
      if (b.truncated) lines.push(`-- truncated at ${b.limit} (raise --limit)`);
      emit(json, lines.join("\n"), b);
      return 0;
    }

    case "overview": {
      const r = await out("GET", `/api/overview${query({ limit })}`);
      emit(json, overviewLines(r.parsed as Overview).join("\n"), r.parsed);
      return 0;
    }

    case "audit": {
      const view = v.shape
        ? "shape"
        : v.pulse
          ? "pulse"
          : v.roi
            ? "roi"
            : undefined;
      const r = await out(
        "GET",
        `/api/audit${query({
          since: str(v.since),
          until: str(v.until),
          limit,
          view,
          scope: view === "pulse" ? str(v.scope) : undefined,
          assume: Array.isArray(v.assume)
            ? v.assume.map(String)
            : v.assume
              ? [String(v.assume)]
              : undefined,
        })}`,
      );
      // A `view` answers with the report already rendered: those three read the WHOLE corpus, which
      // is a server-side walk, not something to page over HTTP.
      const b = r.parsed as {
        items?: { at: string; actor: string; action: string; detail: string }[];
        report?: string;
        data?: unknown;
      };
      if (b.report !== undefined) {
        emit(json, b.report, b.data);
        return 0;
      }
      const items = b.items ?? [];
      emit(
        json,
        items.length
          ? items
              .map((e) => `${e.at}  ${e.actor}  ${e.action}  ${e.detail}`)
              .join("\n")
          : "no audit events",
        items,
      );
      return 0;
    }

    case "ontology": {
      const [sub, file] = positionals;
      if (sub === undefined || sub === "list") {
        const r = await out("GET", "/api/ontology");
        const defs = r.parsed as TypeDef[];
        emit(
          json,
          defs
            .map(
              (d) =>
                `${d.name}  ${d.kind}  ${Object.keys(d.attrs ?? {}).join(", ")}`,
            )
            .join("\n"),
          defs,
        );
        return 0;
      }
      if (sub !== "add-type" || !file) {
        console.error("usage: yoke ontology <list|add-type <json-file>>");
        return 1;
      }
      const { readFileSync } = await import("node:fs");
      const r = await out("POST", "/api/ontology", {
        def: JSON.parse(readFileSync(file, "utf8")),
      });
      const def = r.parsed as TypeDef;
      emit(json, `saved type: ${def.name}`, def);
      return 0;
    }

    case "persona": {
      // `--check <file>` reads a file on THIS machine and asks the corpus whether what it cites
      // still stands. Non-zero exit on any moved or unreadable source: this is meant as a CI gate.
      const check = str(v.check);
      if (check) {
        const { readFileSync } = await import("node:fs");
        let md: string;
        try {
          md = readFileSync(check, "utf8");
        } catch {
          console.error(`cannot read: ${check}`);
          return 1;
        }
        const r = await out("POST", "/api/persona/check", { markdown: md });
        const b = r.parsed as { ok: boolean; report: string; data: object };
        emit(json, b.report, { file: check, ...b.data });
        return b.ok ? 0 : 1;
      }
      const id = positionals[0];
      if (!id) {
        console.error(
          "usage: yoke persona <person-id> [--out dir]\n       yoke persona --check <SKILL.md>",
        );
        return 1;
      }
      const r = await out(
        "GET",
        `/api/persona/${encodeURIComponent(id)}?skill=1`,
      );
      const b = r.parsed as { markdown: string; sources: number };
      // The document is core's; where it lands is the caller's, and fs lives only in this tier.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const outDir = join(str(v.out) ?? ".", `persona-${safeName(id)}`);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, "SKILL.md");
      writeFileSync(file, b.markdown);
      emit(json, `saved: ${file}\nsource knowledge: ${b.sources}`, {
        path: file,
        sources: b.sources,
      });
      return 0;
    }

    case "backfill": {
      const r = await out("POST", "/api/backfill", {
        embeddings: v.embeddings === true,
        rebuild: v.rebuild === true,
        ...(str(v.after) ? { after: str(v.after) } : {}),
      });
      const b = r.parsed as {
        scanned: number;
        embedded?: number;
        skipped?: number;
        next?: string | null;
        linked?: number;
        rebuiltFts?: number | null;
        backend?: string;
      };
      if (b.embedded === undefined) {
        emit(json, `scanned ${b.scanned} entities, linked ${b.linked ?? 0}`, b);
        return 0;
      }
      const lines = [
        `scanned ${b.scanned} entities, embedded ${b.embedded}, skipped ${b.skipped ?? 0}`,
      ];
      if (b.rebuiltFts !== undefined && b.rebuiltFts !== null)
        lines.push(`rebuilt the keyword index: ${b.rebuiltFts} entities`);
      // The warning goes to stderr so a `--json` consumer's stdout stays parseable.
      else if (b.rebuiltFts === null)
        console.error(
          `warning: the keyword index was NOT re-keyed — ${b.backend} has no keyword rebuild.\n` +
            "  The vectors above were rewritten; the keyword rows still hold the text they were " +
            "written with.\n" +
            "  If the index key changed (rather than the embedding model), re-index this backend " +
            "from a source of truth — the two halves of a hybrid search now disagree.",
        );
      // Skipped everything means the provider is not configured — the single most likely reason
      // someone runs this and sees nothing happen.
      if ((b.skipped ?? 0) > 0 && b.embedded === 0)
        lines.push(
          "nothing was embedded: no embedding provider answered. " +
            "Set YOKE_EMBED_URL and YOKE_EMBED_MODEL (see README) and run this again",
        );
      // The walk is bounded, so an unfinished scan is said rather than implied.
      if (b.next) lines.push(`more to scan: --after ${b.next}`);
      emit(json, lines.join("\n"), b);
      return 0;
    }

    case "rename-type": {
      const [from, to] = positionals;
      if (!from || !to) {
        console.error("usage: yoke rename-type <from> <to>");
        return 1;
      }
      const r = await out("POST", "/api/rename-type", {
        from,
        to,
        force: v.force === true,
      });
      const b = r.parsed as { rows?: number; changed?: number };
      const rows = b.rows ?? b.changed ?? 0;
      emit(
        json,
        rows === 0
          ? `no rows carried type "${from}" — nothing to rename`
          : `renamed type "${from}" to "${to}" — ${rows} rows rewritten`,
        b,
      );
      return 0;
    }

    case "token": {
      // A credential is signed with the server's key. The client never holds that key — asking it to
      // would let every caller mint what the server accepts. Arguments are checked by the dispatcher
      // and the scope grammar by the server, which owns the answer either way.
      const r = await out("POST", "/api/tokens", {
        name: v.name,
        scopes: String(v.scopes).split(","),
      });
      const b = r.parsed as {
        name: string;
        scopes: string[];
        token: string;
        refresh: string;
      };
      emit(
        json,
        [
          b.token,
          `  name: ${b.name}   scopes: ${b.scopes.join(", ")}   expires in 7 days`,
          `  refresh (POST /api/refresh, good for a year): ${b.refresh}`,
        ].join("\n"),
        b,
      );
      return 0;
    }

    default:
      return null;
  }
}

/** The corpus's type definitions — a connector is built from them, and only the server has them. */
export async function remoteOntology(remote: Remote): Promise<TypeDef[]> {
  const r = await remote.call("GET", "/api/ontology");
  if (r.status >= 400)
    throw new Error(`${remote.base}: cannot read the ontology (${r.status})`);
  return JSON.parse(r.text) as TypeDef[];
}

/**
 * How much source material travels in one request, in bytes of serialized JSON.
 *
 * Counted in BYTES, not items: items are source material and their sizes differ by orders of
 * magnitude — a PR title against a meeting-note chunk — so a fixed item count sends 20 KiB one run
 * and 30 MiB the next. Measured: 200 note chunks from a real directory came to 300 KiB. Well under
 * the server's bulk cap, because the count is a budget and the cap is the backstop.
 */
const INGEST_BUDGET = 4 * 1024 * 1024;

/**
 * Pull here, commit there.
 *
 * The connector runs on this machine because that is where its credentials and its files are; the
 * gate runs on the server because that is where the corpus is, with its ontology and its embedder.
 * Counts add up across batches, so the tally a caller prints is the tally of the whole run.
 */
export async function remoteIngest(
  remote: Remote,
  connector: Connector,
  opts: { since?: string; scope?: string },
): Promise<IngestResult> {
  const total: IngestResult & { rejected: string[] } = {
    added: 0,
    updated: 0,
    skipped: 0,
    rejected: [],
  };
  let batch: SourceItem[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await remote.call("POST", "/api/ingest", {
      items: batch,
      origin: `connector:${connector.name}`,
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    said(remote);
    const parsed = JSON.parse(r.text || "{}") as Partial<IngestResult>;
    if (r.status >= 400)
      throw new Error(
        `${remote.base}: ${(parsed as { error?: string }).error ?? `HTTP ${r.status}`}`,
      );
    total.added += parsed.added ?? 0;
    total.updated += parsed.updated ?? 0;
    total.skipped += parsed.skipped ?? 0;
    if (parsed.rejected) total.rejected.push(...parsed.rejected);
    batch = [];
    bytes = 0;
  };
  for await (const item of connector.pull(opts.since)) {
    const size = JSON.stringify(item).length;
    // Flush BEFORE adding when this item would push the batch over, so a batch never exceeds the
    // budget — and never on an empty batch, or an item larger than the budget could never be sent.
    if (batch.length > 0 && bytes + size > INGEST_BUDGET) await flush();
    batch.push(item);
    bytes += size;
  }
  await flush();
  return {
    added: total.added,
    updated: total.updated,
    skipped: total.skipped,
    ...(total.rejected.length > 0 ? { rejected: total.rejected } : {}),
  };
}

/**
 * `yoke connect rdb` — query here, map and commit there.
 *
 * The database being read is the caller's: their DSN, their network, and often a machine the server
 * cannot reach at all. So the rows are fetched here and the mapping's two passes run behind the
 * server, where the ontology and the gate are.
 */
export async function remoteIngestMapped(
  remote: Remote,
  connector: RdbMappingConnector,
): Promise<MappedResult> {
  const tables = await Promise.all(
    connector.mapping.map(async (spec) => ({
      table: spec.table,
      // ceiling: `SELECT *` over an operator-supplied table name. The mapping file is trusted
      // operator config, so raw identifier interpolation is acceptable; add quoting if it ever
      // becomes user-facing.
      rows: await connector.query(`SELECT * FROM ${spec.table}`),
    })),
  );
  const total: MappedResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    messages: [],
  };
  const send = async (
    slice: { table: string; rows: Record<string, unknown>[] }[],
    pass: "entities" | "relations",
  ) => {
    const r = await remote.call("POST", "/api/ingest-mapped", {
      mapping: connector.mapping,
      tables: slice,
      pass,
    });
    said(remote);
    const parsed = JSON.parse(r.text || "{}") as Partial<MappedResult> & {
      error?: string;
    };
    if (r.status >= 400)
      throw new Error(`${remote.base}: ${parsed.error ?? `HTTP ${r.status}`}`);
    total.added += parsed.added ?? 0;
    total.updated += parsed.updated ?? 0;
    total.skipped += parsed.skipped ?? 0;
    total.errors += parsed.errors ?? 0;
    if (parsed.messages) total.messages.push(...parsed.messages);
  };
  // Entities first and in slices, then the relations over the same rows. Pass 2 resolves BOTH ends
  // of an FK from the store, so it does not matter which slice a target arrived in — only that
  // every entity is committed before any relation looks for one.
  for (const pass of ["entities", "relations"] as const)
    for (const slice of sliceTables(tables)) await send(slice, pass);
  return total;
}

/** Table rows cut into requests that fit the server's bulk cap, keeping each table's rows together
 * with their own table name. A single row larger than the budget still goes alone — the cap above
 * it is the backstop, and a row that big is a mapping to reconsider, not a slice to make smaller. */
function* sliceTables(
  tables: { table: string; rows: Record<string, unknown>[] }[],
): Generator<{ table: string; rows: Record<string, unknown>[] }[]> {
  let slice: { table: string; rows: Record<string, unknown>[] }[] = [];
  let bytes = 0;
  for (const t of tables) {
    let rows: Record<string, unknown>[] = [];
    for (const row of t.rows) {
      const size = JSON.stringify(row).length;
      if (
        (rows.length > 0 || slice.length > 0) &&
        bytes + size > INGEST_BUDGET
      ) {
        if (rows.length > 0) slice.push({ table: t.table, rows });
        yield slice;
        slice = [];
        rows = [];
        bytes = 0;
      }
      rows.push(row);
      bytes += size;
    }
    if (rows.length > 0) slice.push({ table: t.table, rows });
  }
  // Always at least one request: an empty mapping still has to reach the gate for its refusals.
  yield slice;
}

/**
 * `yoke relate` — a model proposes the edges between records already in the corpus.
 *
 * Split where the work is: the server picks the candidates and their neighbours (a page over the
 * whole namespace plus a search per anchor), the model runs HERE with this machine's YOKE_LLM_*,
 * and each accepted proposal goes back through the ordinary link route — so an edge a model
 * proposed passes the same gate as one a person typed.
 */
export async function remoteRelate(
  remote: Remote,
  relater: Relater,
  opts: { limit?: string; neighbours?: string },
): Promise<{
  records: number;
  groups: number;
  added: number;
  existed: number;
  rejected: number;
  failedCalls: number;
  rejections: Map<string, number>;
}> {
  const r = await remote.call(
    "GET",
    `/api/relate/groups${query({ limit: opts.limit, neighbours: opts.neighbours })}`,
  );
  said(remote);
  if (r.status >= 400)
    throw new Error(
      `${remote.base}: ${(JSON.parse(r.text || "{}") as { error?: string }).error ?? `HTTP ${r.status}`}`,
    );
  const b = JSON.parse(r.text) as {
    records: number;
    groups: { refs: Ref[]; byRef: Record<string, string> }[];
  };
  let added = 0;
  let existed = 0;
  // A call that never answered and a proposal the gate refused are different failures: the first
  // says the endpoint is unreachable, the second says the model answered and was wrong. Counted
  // together, a corpus whose every proposal is a duplicate edge reports an outage.
  let failedCalls = 0;
  let rejected = 0;
  const rejections = new Map<string, number>();
  for (const g of b.groups) {
    const proposed = await relater(g.refs);
    if (proposed === null) {
      failedCalls++;
      continue;
    }
    for (const p of proposed) {
      const from = g.byRef[p.from];
      const to = g.byRef[p.to];
      if (!from || !to) continue;
      const res = await remote.call("POST", "/api/link", {
        type: p.type,
        from,
        to,
        // The sentence that justified the edge, kept beside it for the same reason a record keeps
        // its quote: a reviewer deciding whether this link is real should not have to reconstruct
        // why a model thought so.
        attributes: p.because ? { rationale: p.because } : {},
      });
      if (res.status === 201) {
        added++;
      } else if (res.status === 200) {
        existed++;
      } else {
        // One bad proposal must not end a batch that also contains good ones — but a bare count of
        // rejections tells nobody what to change. The reason is the whole value of the number.
        rejected++;
        const why =
          (JSON.parse(res.text || "{}") as { error?: string }).error ??
          `HTTP ${res.status}`;
        rejections.set(why, (rejections.get(why) ?? 0) + 1);
      }
    }
  }
  return {
    records: b.records,
    groups: b.groups.length,
    added,
    existed,
    rejected,
    failedCalls,
    rejections,
  };
}

interface Overview {
  entities: {
    total: number;
    byType: Record<
      string,
      { verified: number; stale: number; deprecated: number }
    >;
  };
  relations: { total: number; byType: Record<string, number> };
  hubs: { degree: number; entity: Row }[];
  authors: { actor: string; verified: number }[];
}

/** The corpus shape, as lines. Types with nothing in them are noise on a report whose job is
 * showing what IS here. */
function overviewLines(o: Overview): string[] {
  const typeRows = Object.entries(o.entities.byType)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, c]) => {
      const parts = (["verified", "stale", "deprecated"] as const)
        .filter((k) => c[k] > 0)
        .map((k) => `${c[k]} ${k}`);
      return `  ${type.padEnd(14)} ${parts.join(", ")}`;
    });
  return [
    `${o.entities.total} records, ${o.relations.total} relations`,
    "",
    "by type",
    ...(typeRows.length ? typeRows : ["  (none)"]),
    "",
    "relations",
    ...(Object.entries(o.relations.byType).length
      ? Object.entries(o.relations.byType)
          .sort((a, b) => b[1] - a[1])
          .map(([type, n]) => `  ${type.padEnd(14)} ${n}`)
      : ["  (none)"]),
    "",
    "hubs",
    ...(o.hubs.length
      ? o.hubs.map(
          (h) =>
            `  ${String(h.degree).padStart(4)}  ${h.entity.type.padEnd(13)} ${h.entity.summary ?? ""}`,
        )
      : ["  (none)"]),
    "",
    "authors",
    ...(o.authors.length
      ? o.authors.map((a) => `  ${String(a.verified).padStart(4)}  ${a.actor}`)
      : ["  (none)"]),
  ];
}
