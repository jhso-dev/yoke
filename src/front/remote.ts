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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WithheldStats } from "../core/inject.js";
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

/** The remote, or null when this machine is on the local path. */
export function resolveRemote(env: Env): Remote | null {
  const base = env.YOKE_SERVER;
  if (!base) return null;
  let cached: Cached | null = null;
  let minted: string | undefined;
  // An explicitly configured credential is not ours to manage: no cache, no refresh, no exchange.
  const pinned = env.YOKE_TOKEN;

  const exchange = async (): Promise<Cached | null> => {
    const c = await fromGitHub(base, env);
    if (c?.token) minted = c.login ?? "";
    return c;
  };

  const credential = async (): Promise<string> => {
    if (pinned) return pinned;
    if (cached?.token) return cached.token;
    const disk = readCache(base, env);
    if (disk.token) {
      cached = disk;
      return disk.token;
    }
    cached = (await fromRefresh(base, env, disk.refresh)) ?? (await exchange());
    if (!cached?.token) throw new Error(`cannot authenticate to ${base}`);
    return cached.token;
  };

  const renew = async (): Promise<string | null> => {
    if (pinned) return null;
    const disk = readCache(base, env);
    cached = (await fromRefresh(base, env, disk.refresh)) ?? (await exchange());
    return cached?.token ?? null;
  };

  return {
    base,
    announce: () => {
      if (minted === undefined) return "";
      const who = minted;
      minted = undefined;
      return `yoke: authenticated as ${who} via GitHub — credential cached in ${env.YOKE_AUTH_DIR || "~/.yoke"}\n`;
    },
    async fetch(url, init) {
      // `Headers`, not a spread: the MCP transport passes a Headers instance, and spreading one
      // yields an empty object — which silently drops its content negotiation and session id.
      const send = (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        return globalThis.fetch(url, { ...init, headers });
      };
      const res = await send(await credential());
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

function query(pairs: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(pairs)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Rows out of whatever shape the route returns — some answer a bare array, some an envelope. */
function rowsOf(parsed: unknown): Row[] {
  if (Array.isArray(parsed)) return parsed as Row[];
  const o = parsed as Record<string, unknown>;
  for (const k of ["items", "records", "results", "entities"]) {
    if (Array.isArray(o?.[k])) return o[k] as Row[];
  }
  return [];
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

/**
 * Run `command` against the server, or return null when the server has no route for it.
 *
 * Null is the signal that a command is LOCAL — `init`, `serve`, `ui`, `mcp`, `token`, `backup` and
 * the capture connectors act on a machine, not on a corpus, and a bound YOKE_SERVER does not change
 * that. The caller falls through to the local path for those and refuses nothing.
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
  ): Promise<{ ok: boolean; parsed: unknown; text: string }> => {
    const r = await remote.call(method, path, body);
    // Ahead of the command's own output, so it rides the same delivery the exchange paid for. Under
    // --json it goes to stderr instead: still seen by a person, never inside the parsed document.
    const said = remote.announce();
    if (said) (json ? process.stderr : process.stdout).write(said);
    if (r.status === 204) return { ok: true, parsed: null, text: "" };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(r.text);
    } catch {
      // A text/plain route (inject --unseen). The body is the answer.
    }
    if (r.status >= 400) {
      const msg = (parsed as { error?: string } | null)?.error ?? r.text.trim();
      throw new Error(`${remote.base}: ${msg || `HTTP ${r.status}`}`);
    }
    return { ok: true, parsed, text: r.text };
  };

  const printRows = (parsed: unknown, empty: string): number => {
    const rows = rowsOf(parsed);
    if (json) console.log(JSON.stringify(parsed, null, 2));
    else if (rows.length === 0) console.log(empty);
    else for (const r of rows) console.log(line(r));
    return 0;
  };

  switch (command) {
    case "inject": {
      const q = positionals.join(" ");
      const r = await out(
        "GET",
        `/api/inject${query({
          q: q || undefined,
          scope: str(v.scope),
          unseen: v.unseen ? "1" : undefined,
          depth: str(v.depth),
          limit,
        })}`,
      );
      // `--unseen` answers text/plain — the identical lines the local path prints — so it passes
      // through untouched. Everything else is the JSON briefing.
      if (r.parsed === null) {
        // text/plain: `unseenReport`'s own lines, which is what the local path prints too — so the
        // two deployments hand a session byte-identical text.
        if (r.text.trim()) console.log(r.text.trimEnd());
        return 0;
      }
      if (json) {
        console.log(JSON.stringify(r.parsed, null, 2));
        return 0;
      }
      const b = r.parsed as {
        items?: (Row & { citation?: string; conflictsWith?: string[] })[];
        omitted?: number;
        walk?: { depth: number; nodes: number; truncated?: boolean } | null;
        withheld?: WithheldStats | null;
      };
      const items = b.items ?? [];
      // The server's row carries core's citation string and the summary already — the same two
      // halves the local path joins — so the line is identical without a second read.
      const lines = items.map(
        (it) =>
          `${it.citation ?? it.id}  ${it.summary ?? ""}` +
          (it.conflictsWith?.length
            ? `\n  ! contradicted by ${it.conflictsWith.join(" ")} — both are recorded, neither is settled`
            : ""),
      );
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
      if (b.withheld)
        lines.push(
          `${items.length ? "-- also held back:" : "no verified knowledge —"} ${describeWithheld(b.withheld)}`,
        );
      console.log(lines.length ? lines.join("\n") : "no verified knowledge");
      return 0;
    }
    case "list": {
      const r = await out(
        "GET",
        `/api/entities${query({ type: str(v.type), status: str(v.status), limit, after: str(v.after) })}`,
      );
      return printRows(r.parsed, "nothing to list");
    }
    case "search": {
      const r = await out(
        "GET",
        `/api/search${query({ q: positionals.join(" "), limit })}`,
      );
      return printRows(r.parsed, "no matches");
    }
    case "get": {
      const id = positionals[0];
      if (!id) throw new Error("usage: yoke get <id>");
      const r = await out("GET", `/api/entity/${encodeURIComponent(id)}`);
      const e = (
        r.parsed as {
          entity?: Row & { version?: number; attributes?: unknown };
        }
      ).entity;
      if (!e) throw new Error(`no such record: ${id}`);
      console.log(
        json
          ? JSON.stringify(r.parsed, null, 2)
          : `${line(e)}  v${e.version}  ${JSON.stringify(e.attributes)}`,
      );
      return 0;
    }
    case "review": {
      const r = await out("GET", `/api/review${query({ limit })}`);
      return printRows(r.parsed, "nothing to re-confirm");
    }
    case "conflicts": {
      const r = await out("GET", `/api/conflicts${query({ limit })}`);
      return printRows(r.parsed, "no conflicts");
    }
    case "ontology": {
      if (positionals.length > 0) return null;
      const r = await out("GET", "/api/ontology");
      console.log(JSON.stringify(r.parsed, null, 2));
      return 0;
    }
    case "add": {
      const type = positionals[0];
      if (!type) throw new Error("usage: yoke add <type> --attr k=v");
      const r = await out("POST", "/api/entity", {
        type,
        attributes: attrsOf(v),
        ...(str(v.scope) ? { scope: str(v.scope) } : {}),
      });
      console.log(
        json ? JSON.stringify(r.parsed, null, 2) : line(r.parsed as Row),
      );
      return 0;
    }
    case "link": {
      const [from, type, to] = positionals;
      if (!from || !type || !to)
        throw new Error("usage: yoke link <from-id> <relation> <to-id>");
      const r = await out("POST", "/api/link", {
        type,
        from,
        to,
        attributes: attrsOf(v),
      });
      console.log(
        json ? JSON.stringify(r.parsed, null, 2) : line(r.parsed as Row),
      );
      return 0;
    }
    case "verify":
    case "deprecate": {
      if (positionals.length === 0)
        throw new Error(`usage: yoke ${command} <id...>`);
      const r = await out("POST", `/api/${command}`, {
        ids: positionals,
        ...(str(v.reason) ? { reason: str(v.reason) } : {}),
      });
      console.log(
        json
          ? JSON.stringify(r.parsed, null, 2)
          : `${command}d ${positionals.length}`,
      );
      return 0;
    }
    default:
      return null;
  }
}
