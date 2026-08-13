#!/usr/bin/env node

// yoke CLI skeleton (PLAN 1.7) — uses only node:util parseArgs (no commander etc.).
// Command handlers are split out as runCli(argv, env) — testable without spawning a process; exit code is the return value.
// Time is obtained only in this front tier (core receives `now` by injection).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { makeGithubPrConnector } from "../../connectors/github-pr.js";
import { ingest } from "../../connectors/ingest.js";
import { makeNotesConnector } from "../../connectors/meeting-notes.js";
import {
  ingestMapped,
  type MappingSpec,
  makeRdbMappingConnector,
} from "../../connectors/rdb-mapping.js";
import { makeSlackConnector } from "../../connectors/slack.js";
import type { Connector } from "../../connectors/types.js";
import { overview } from "../../core/aggregate.js";
import { backfillAuthorship, backfillEmbeddings } from "../../core/backfill.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { makeFetchEmbedder } from "../../core/embedding.js";
import {
  BRIEFING_LIMIT,
  inject,
  pointer,
  WALK_BUDGET,
} from "../../core/inject.js";
import {
  deprecate,
  downstreamOf,
  listVersions,
  staleEntities,
  verify,
} from "../../core/lifecycle.js";
import { normalizeNs, resolveNs } from "../../core/namespace.js";
import { seedOntology, type TypeDef } from "../../core/ontology.js";
import {
  checkPersonaSources,
  NotAPerson,
  type PersonaResult,
  parsePersonaSources,
  personaQuery,
  renderPersonaSkill,
  safeName,
} from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import {
  consumptionCounts,
  describeWithheld,
  injectDetail,
  injectShape,
  makeActorNames,
  rankByConsumption,
  retirementOf,
  shownStatus,
  summarize,
} from "../display.js";
import { runMcp } from "../mcp/index.js";
import { runServe } from "../serve/index.js";
import { parseScope } from "../serve/rbac.js";
import { type AuditEvent, openStore, type YokeStore } from "../store.js";
import { runUi } from "../ui/server.js";
import { banner, decorated, getStartedBlock, log, version } from "./banner.js";

type Values = {
  db?: string;
  /** `--reason` on a governance act: why a record was retired, kept on the audit row. */
  reason?: string;
  shards?: string;
  actor?: string;
  ns?: string;
  port?: string;
  host?: string;
  attr?: string[];
  version?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  help?: boolean;
  repo?: string;
  since?: string;
  out?: string;
  mapping?: string;
  dsn?: string;
  sqlite?: string;
  channel?: string;
  name?: string;
  scope?: string;
  scopes?: string;
  auth?: boolean;
  until?: string;
  force?: boolean;
  "replica-of"?: string;
  "refresh-sec"?: string;
  "all-drafts"?: boolean;
  "include-draft"?: boolean;
  relations?: boolean;
  after?: string;
  status?: string;
  "as-of"?: string;
  stale?: boolean;
  embeddings?: boolean;
  rebuild?: boolean;
  shape?: boolean;
  depth?: string;
  check?: string;
};

const OPTIONS = {
  db: { type: "string" },
  shards: { type: "string" },
  actor: { type: "string" },
  ns: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  attr: { type: "string", multiple: true },
  version: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  repo: { type: "string" },
  since: { type: "string" },
  out: { type: "string" },
  mapping: { type: "string" },
  dsn: { type: "string" },
  sqlite: { type: "string" },
  channel: { type: "string" },
  name: { type: "string" },
  scope: { type: "string" },
  scopes: { type: "string" },
  auth: { type: "boolean" },
  until: { type: "string" },
  // Why a record was retired. Governance acts only — see cmdDeprecate.
  reason: { type: "string" },
  force: { type: "boolean" },
  "replica-of": { type: "string" },
  "refresh-sec": { type: "string" },
  "all-drafts": { type: "boolean" },
  "include-draft": { type: "boolean" },
  relations: { type: "boolean" },
  after: { type: "string" },
  status: { type: "string" },
  "as-of": { type: "string" },
  stale: { type: "boolean" },
  embeddings: { type: "boolean" },
  rebuild: { type: "boolean" },
  shape: { type: "boolean" },
  depth: { type: "string" },
  check: { type: "string" },
} as const;

type Env = Record<string, string | undefined>;

const now = (): string => new Date().toISOString();

const resolveDb = (v: Values, env: Env): string =>
  v.db ?? env.YOKE_DB ?? "./yoke.db";

const resolveActor = (v: Values, env: Env): string =>
  v.actor ?? env.YOKE_ACTOR ?? "yoke:system";

/**
 * A caller error, as distinct from a failure. Thrown by the argument readers below and caught once at
 * the dispatcher, which prints the message and exits 1.
 *
 * Named so that one catch can tell "you typed something I cannot act on" from "something broke",
 * because the two deserve different sentences and only one of them is the reader's to fix.
 */
class UsageError extends Error {}

/**
 * A numeric flag, or a refusal naming what was wrong with it.
 *
 * Every numeric flag was `Number(v.x)`, which answers a DIFFERENT question rather than declining the
 * one asked. Measured: `--limit abc` reached sqlite and surfaced as "datatype mismatch"; `--limit 0`
 * crashed in the pager with "Cannot read properties of undefined"; `--version abc` and `--version 99`
 * both printed "not found: <id>" for a record that exists, which is a lie about the corpus rather than
 * a complaint about the argument; `--depth abc` silently walked zero hops and returned "no results"
 * where `--depth 2` had an answer. NaN compares false against everything, so an unparseable number
 * does not fail — it quietly changes the answer.
 *
 * `0x10` parsing as 16 while `3.7` errors is the same objection: a limit is a count, and a count is
 * written in digits.
 */
function intFlag(
  raw: string | undefined,
  name: string,
  min = 1,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim()) || raw.trim() === "")
    throw new UsageError(`--${name} must be a whole number (got "${raw}")`);
  const n = Number(raw);
  if (n < min)
    throw new UsageError(`--${name} must be at least ${min} (got ${n})`);
  return n;
}

/**
 * A timestamp flag, or a refusal.
 *
 * `--as-of yesterday`, `--as-of not-a-date`, `--as-of ""` and `--as-of 2026-13-45T99:99:99Z` were all
 * accepted with exit 0. Downstream, `Date.parse` yields NaN and every comparison against it is false,
 * so `versionAsOf` keeps the latest version while `isFresh` reports everything expired: the answer is
 * a plausible-looking history of a moment that does not exist. A question about the past is the one
 * question whose answer a reader cannot sanity-check, so the instant has to be real before it is used.
 */
function instantFlag(
  raw: string | undefined,
  name: string,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Number.isNaN(Date.parse(raw)))
    throw new UsageError(
      `--${name} must be an ISO 8601 instant, e.g. 2026-08-13T00:00:00Z (got "${raw}")`,
    );
  return raw;
}

/**
 * Refuse the arguments a command cannot use, naming them.
 *
 * `yoke inject cache sessions` — the natural way to type it — answered the query "cache", returned a
 * record about invoices that the full phrase excludes, and wrote "cache" into the audit trail as the
 * question that had been asked. `search`, `get`, `history`, `backup` and `ontology list` all dropped
 * extra words the same way. An argument the CLI cannot honour is not a detail to swallow: the reader
 * believes they asked something they did not, and the trail agrees with them.
 */
function noExtra(positionals: string[], keep: number, usage: string): void {
  if (positionals.length > keep)
    throw new UsageError(
      `unexpected argument: ${positionals
        .slice(keep)
        .map((p) => `"${p}"`)
        .join(" ")}` + `\nquote a phrase to pass it as one value\n${usage}`,
    );
}

/** The four stored values of `status`. `stale` is NOT among them — see `statusFilter`. */
const STORED_STATUSES = ["draft", "verified", "deprecated"] as const;

/**
 * A `--status` filter, or a refusal that names why the value cannot match.
 *
 * `list --status stale` answered "nothing to list" on a database whose own `overview` reported 132
 * stale records, because `stale` is computed at read time and never stored — the filter is pushed down
 * to SQL, where no row can carry it. Silence is the worst possible answer to the obvious way of asking
 * "what has expired": it reads as "none have", which is the opposite of the truth. `--status bogus` and
 * `--status DRAFT` were equally silent, and equally indistinguishable from an empty corpus.
 *
 * The stale case gets the command that does answer it. The others get the values that exist.
 */
function statusFilter(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === "stale")
    throw new UsageError(
      "stale is computed at read time, not stored, so no filter can match it — " +
        "'yoke review --stale' is the queue of verified records past their TTL",
    );
  if (!STORED_STATUSES.includes(raw as (typeof STORED_STATUSES)[number]))
    throw new UsageError(
      `--status must be one of ${STORED_STATUSES.join(", ")} (got "${raw}")`,
    );
  return raw;
}

/**
 * A `--type` filter, or a refusal listing the types that exist.
 *
 * Same defect as `--status`: an unregistered name answered "nothing to list", so a typo and an empty
 * corpus produced identical output. The ontology is right there and knows every valid name.
 */
function typeFilter(
  raw: string | undefined,
  ontology: TypeDef[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (!ontology.some((t) => t.name === raw))
    throw new UsageError(
      `unknown type: ${raw}\ndeclared types: ${ontology
        .map((t) => t.name)
        .join(", ")}`,
    );
  return raw;
}

/** --attr k=v list → attributes. A repeated key becomes a string[]. */
function parseAttrs(attrs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    const eq = a.indexOf("=");
    if (eq === -1) throw new Error(`--attr must be key=value: ${a}`);
    const key = a.slice(0, eq);
    const val = a.slice(eq + 1);
    if (key in out) {
      const cur = out[key];
      if (Array.isArray(cur)) cur.push(val);
      else out[key] = [cur, val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Machine JSON with --json, human text otherwise. */
function emit(v: Values, human: string, data: unknown): void {
  console.log(v.json ? JSON.stringify(data) : human);
}

function formatEntity(
  e: Entity | Relation,
  ontology?: TypeDef[],
  at?: string,
): string {
  // With the ontology, the column is what injection would decide; without it, the stored value. The two
  // callers that omit it print a record they have just committed, and a fresh commit is a draft.
  const status = ontology && at ? shownStatus(e, ontology, at) : e.status;
  return `${e.id}  ${e.type}  ${status}  v${e.version}  ${JSON.stringify(e.attributes)}`;
}

/**
 * A record in one line for a report someone has to ACT on: `summarize` for the words, the id kept
 * because acting means running another command against it.
 *
 * Not `formatEntity`, which dumps `attributes` whole — one governed decision's rationale is a page of
 * prose, so a routing list built from it scrolls the answer off the screen. Measured on the demo
 * corpus: two dependents filled the terminal.
 */
function label(
  e: { id: string; type?: string; attributes?: Record<string, unknown> },
  ontology: TypeDef[],
): string {
  if (e.type === undefined || e.attributes === undefined) return e.id;
  return `${summarize({ type: e.type, attributes: e.attributes }, ontology)}  [${e.type} ${e.id}]`;
}

/** --shards <file> (or YOKE_SHARDS) if set, else undefined — the single-sqlite fast path. */
const resolveShards = (v: Values, env: Env): string | undefined =>
  v.shards ?? env.YOKE_SHARDS;

/** What the store a command just opened is, for messages and `--json`.
 *
 * `resolveDb` alone names the LOCAL sqlite whatever the store actually is, so `yoke init --shards
 * cfg.json` reported `initialized: ./yoke.db` — a file it had not touched — and put that path in its
 * JSON. Under a remote backend it is half true (the local db holds this client's audit + tokens), so
 * this reports both halves rather than picking one. */
function storeLabel(v: Values, env: Env): string {
  const shards = resolveShards(v, env);
  if (shards) return `shards ${shards}`;
  const db = resolveDb(v, env);
  const remote = env.YOKE_OPENSEARCH_URL ?? env.YOKE_POSTGRES_URL;
  if (remote) return `${remote} (audit + tokens: ${db})`;
  return db;
}

/** Compact grouped usage — one source for --help, no-args, and unknown-command. */
/** Every dispatchable command name, for the did-you-mean below. */
const COMMANDS = [
  "init",
  "link",
  "add",
  "get",
  "list",
  "graph",
  "search",
  "review",
  "verify",
  "deprecate",
  "inject",
  "history",
  "conflicts",
  "overview",
  "ontology",
  "persona",
  "connect",
  "backfill",
  "rename-type",
  "audit",
  "backup",
  "restore",
  "export",
  "mcp",
  "ui",
  "serve",
  "token",
  "help",
];

/** Levenshtein distance, iterative two-row. Small enough not to be worth a dependency. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length];
}

function usage(): string {
  return `yoke — knowledge your AI can trust

getting started:
  init                      create ./yoke.db and seed the ontology
  add <type> --attr k=v     stage knowledge (enters as draft)
  review / verify <id...>   inspect and promote drafts
  inject <query>            retrieve verified knowledge with citations (--scope id, --depth n)

knowledge:  get, list, graph, search, history, conflicts, deprecate, ontology, persona
  overview                  the shape of the whole corpus: types, hubs, authors (--limit n)
  link <from> <relation> <to>   record a relation (works_on, supersedes, relates_to …)
capture:    connect github-pr|slack|notes|rdb
serving:    mcp, ui, serve, token   (--port, --host; loopback unless --host is given)
data:       backup, restore, export, audit, backfill, rename-type
  audit --shape             workload composition: anchored / briefing / plain injections

common options: --db <path> --ns <namespace> --actor <id> --json
run 'yoke <command>' with missing args to see its usage`;
}

/** Ontology-needing commands: an empty ontology means the DB was never `yoke init`ed.
 * Returns the ontology, or null after printing an actionable error (caller returns 1). */
function requireOntology(
  store: YokeStore,
  ns: string | null | undefined,
  v: Values,
  env: Env,
): TypeDef[] | null {
  const ontology = store.loadOntology(ns);
  if (ontology.length === 0) {
    console.error(
      `not initialized: ${storeLabel(v, env)} — run 'yoke init' first`,
    );
    return null;
  }
  return ontology;
}

// Open the resolved store (ShardedStorage under --shards, else SqliteStorage), run fn, always close.
async function withStore<T>(
  v: Values,
  env: Env,
  fn: (s: YokeStore) => Promise<T>,
): Promise<T> {
  const store = await openStore(
    { db: resolveDb(v, env), shards: resolveShards(v, env) },
    env,
  );
  await store.init();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** The recommended local model, and the reason it is this one.
 *
 * `bge-m3` covers 100+ languages in one 1024-dimension model (MIT, 8192-token context) and lives in
 * Ollama's shared cache — 0 bytes in this package, which is why no model ships with yoke (SPEC "Tech
 * stack"). `nomic-embed-text` was suggested here before and is English-centric: on a corpus with
 * substantial non-English knowledge it makes the vector half of retrieval quietly useless, which is
 * indistinguishable from having no embedder at all. */
const SUGGESTED_EMBED_MODEL = "bge-m3";

// Ollama auto-detect (TTY init only): a reachable local Ollama with no embedder
// configured means duplicate/contradiction detection is silently off. Suggest the
// two env vars that enable it — and never write them, because a tool that edits the
// environment behind you is worse than one that tells you what to type.
// Never blocks (300ms timeout) and never fails init.
async function suggestOllamaIfIdle(env: Env): Promise<void> {
  if (env.YOKE_EMBED_URL) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300);
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: ac.signal,
    });
    if (!res.ok) return;
    // The same response already lists the installed models, so the advice can be exact instead of
    // sending someone to configure a model they do not have.
    const body = (await res.json().catch(() => null)) as {
      models?: { name?: string }[];
    } | null;
    const has = (body?.models ?? []).some((m) =>
      (m.name ?? "").startsWith(SUGGESTED_EMBED_MODEL),
    );
    console.log(
      log.warn(
        "embedding provider not configured — Ollama detected; " +
          (has ? "" : `run 'ollama pull ${SUGGESTED_EMBED_MODEL}', then `) +
          `export YOKE_EMBED_URL=http://localhost:11434/v1 YOKE_EMBED_MODEL=${SUGGESTED_EMBED_MODEL} ` +
          "to enable duplicate/contradiction detection",
      ),
    );
  } catch {
    // unreachable / timed out — stay silent
  } finally {
    clearTimeout(timer);
  }
}

async function cmdInit(v: Values, env: Env): Promise<number> {
  // Two values on purpose: `store` is what a person needs to read (the shards config, or the remote
  // URL and which local file holds the audit half), while `db` stays the LOCAL sqlite path — a script
  // reading `.db` wants a path.
  const store_ = storeLabel(v, env);
  const db = resolveDb(v, env);
  // Decorate only on an interactive stdout (never under --json), so non-TTY and
  // machine output stay byte-identical to the plain path.
  const deco = decorated() && !v.json;
  return withStore(v, env, async (store) => {
    // Idempotent re-run: if yoke:system already exists, do not re-seed.
    if (await store.getEntity("yoke:system")) {
      if (deco) {
        const b = banner();
        if (b) console.log(`\n${b}\n`);
      }
      emit(v, `already initialized: ${store_}`, {
        db,
        store: store_,
        seeded: false,
      });
      return 0;
    }
    const ontology = seedOntology();
    await store.saveOntology(ontology);
    // Seed the yoke:system person — no gate bypass (putEntity). Use commit with a well-known id.
    // A nonexistent id creates version 1, so it passes the gate normally (bootstrap).
    const ts = now();
    await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "system" } },
      { actor: "yoke:system", origin: "cli", occurred_at: ts },
      ts,
      { existingId: "yoke:system" },
    );
    // Leaving the system person as a draft would keep it in the review queue forever — promote right after seeding.
    await verify(store, ["yoke:system"], "yoke:system", ts);
    if (deco) {
      const b = banner();
      if (b) console.log(`\n${b}\n`);
      const entityTypes = ontology.filter((d) => d.kind === "entity").length;
      const relTypes = ontology.filter((d) => d.kind === "relation").length;
      console.log(log.ok(`database created: ${db}`));
      console.log(
        log.ok(
          `ontology seeded: ${entityTypes} entity types, ${relTypes} relation types`,
        ),
      );
      console.log(log.ok("system actor ready"));
      console.log(getStartedBlock());
      await suggestOllamaIfIdle(env);
    } else {
      emit(v, `initialized: ${store_}`, { db, store: store_, seeded: true });
    }
    return 0;
  });
}

async function cmdAdd(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const type = positionals[0];
  noExtra(
    positionals,
    1,
    "usage: yoke add <type> [--actor id] [--attr k=v ...] [--scope entity-id]\n" +
      "  values go in --attr, not after the type",
  );
  if (!type) {
    console.error(
      "usage: yoke add <type> [--actor id] [--attr k=v ...] [--scope entity-id]",
    );
    return 1;
  }
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  const attributes = parseAttrs(v.attr ?? []);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    try {
      const prov = { actor, origin: "cli", occurred_at: ts };
      const { entity, duplicates, duplicateDetection } = await commit(
        store,
        ontology,
        { type, attributes },
        prov,
        ts,
        {
          embedder: makeFetchEmbedder(env),
          ns,
          // Capture-side linking (v4.0): --scope <entity-id> attaches the new knowledge to that
          // record. One commit, not two — a bad --scope used to be reported as a rejection with the
          // record already stored (see `attachTo` in core/commit.ts).
          ...(v.scope ? { attachTo: v.scope } : {}),
        },
      );
      const lines = [formatEntity(entity)];
      if (duplicates.length > 0)
        lines.push(
          `similar knowledge (${duplicates.length}): ${duplicates.map((d) => d.id).join(" ")}`,
        );
      // The gate returns WHY duplicates is empty, and nothing read it — so a person adding a record
      // with no embedder configured was told nothing and reasonably assumed it had been checked.
      // "no similar knowledge" and "nobody looked" are different facts (SPEC gate stage 3).
      else if (duplicateDetection === "skipped")
        lines.push(
          // No "(see README)": a notice printed by a CLI has to be actionable from the CLI, and this one
          // is the only line in a first session that sends the reader out of the terminal.
          "no duplicate check ran: set YOKE_EMBED_URL and YOKE_EMBED_MODEL " +
            "(any OpenAI-compatible /embeddings endpoint), then: yoke backfill --embeddings",
        );
      // --json emits the entity as-is (preserving the existing contract). Both notices are human text only.
      emit(v, lines.join("\n"), entity);
      return 0;
    } catch (e) {
      if (e instanceof CommitRejected) {
        console.error(`rejected (${e.reason}): ${e.message}`);
        return 1;
      }
      throw e;
    }
  });
}

// link — the creation path for relations. `yoke add <relation>` cannot work: a relation needs
// endpoints and `add` has nowhere to put them, so it fails with "<type> is a relation type".
// That left `relates_to` reachable only through `add --scope`, and `works_on`/`supersedes` reachable
// not at all — a collaboration whose roster could never be recorded. Reads as a sentence on purpose:
// `yoke link <person> works_on <collaboration>`.
async function cmdLink(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [from, type, to] = positionals;
  noExtra(
    positionals,
    3,
    "usage: yoke link <from-id> <relation> <to-id> [--actor id] [--attr k=v ...]",
  );
  if (!from || !type || !to) {
    console.error(
      "usage: yoke link <from-id> <relation> <to-id> [--actor id] [--attr k=v ...]\n" +
        "  e.g. yoke link 01H… works_on 01H…",
    );
    return 1;
  }
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  const attributes = parseAttrs(v.attr ?? []);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    try {
      // Straight through the same gate as everything else: it is the gate that checks the type is a
      // declared relation and that both endpoints exist, so this command adds no rules of its own.
      const { entity, existed } = await commit(
        store,
        ontology,
        { type, attributes, from, to },
        { actor, origin: "cli", occurred_at: ts },
        ts,
        { ns },
      );
      emit(v, formatEntity(entity), entity);
      // Said out loud, because the exit code and the printed row are identical either way: a second
      // `link` of the same edge is now a no-op, and reporting it as a link would credit the caller
      // with a change they did not make. Human output only — --json stays the record.
      if (existed) console.error("already linked — no new relation recorded");
      return 0;
    } catch (e) {
      if (e instanceof CommitRejected) {
        console.error(`rejected (${e.reason}): ${e.message}`);
        return 1;
      }
      throw e;
    }
  });
}

const GET_USAGE = "usage: yoke get <id> [--version n] [--relations]";

async function cmdGet(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const id = positionals[0];
  noExtra(positionals, 1, GET_USAGE);
  if (!id) {
    console.error(GET_USAGE);
    return 1;
  }
  const version = intFlag(v.version, "version");
  const actor = resolveActor(v, env);
  const getNs = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    // Filtered after the read, because ids are globally unique and the port's `getEntity` takes no ns.
    // Without this, `yoke --ns teamA get <teamB id>` printed another tenant's knowledge in full — the
    // same hole `verify`/`deprecate` had, on the read side.
    const inNs = <T extends { ns?: string | null }>(r: T | null): T | null =>
      r && normalizeNs(r.ns) === getNs ? r : null;
    const e = inNs(await store.getEntity(id, version));
    if (!e) {
      // An id `link` handed back is an edge id, and until the port could read one this said "not
      // found" for a row the same command had just reported storing. A relation is knowledge in its
      // own right, so it answers a read like everything else.
      const rel = inNs((await store.getRelation?.(id, version)) ?? null);
      if (rel) {
        store.logAudit({
          actor,
          action: "read",
          detail: rel.id,
          at: now(),
          ns: getNs,
        });
        emit(
          v,
          `${formatEntity(rel)}\n  ${rel.from} -${rel.type}-> ${rel.to}`,
          rel,
        );
        return 0;
      }
      // "not found" is a claim about the corpus, and with `--version` it was usually false: `get <id>
      // --version 99` printed it for a record that exists at v1 and v2. The reader takes the sentence at
      // its word and stops looking. Ask again without the pin before answering — an id that does not
      // resolve and a version that does not exist are different answers.
      if (version !== undefined) {
        const latest =
          inNs(await store.getEntity(id)) ??
          inNs((await store.getRelation?.(id)) ?? null);
        if (latest) {
          console.error(
            `${id} has no version ${version} — the latest is ${latest.version} (omit --version for it)`,
          );
          return 1;
        }
      }
      console.error(`not found: ${id}`);
      return 1;
    }
    // A read of full attributes, which is where SPEC draws the audit line — and the twin of
    // `GET /api/entity/:id`. The rule is per front ADAPTER: if only the browser wrote this row,
    // "who read this record" would be unanswerable for every read done the normal way, which is
    // exactly how `verify` drifted before v5.0.
    const readAt = now();
    store.logAudit({
      actor,
      action: "read",
      detail: e.id,
      at: readAt,
      ns: getNs,
    });
    const ontology = store.loadOntology(getNs);
    // A retired record raises exactly one question, and the answer is on the audit row (see history).
    const retired =
      e.status === "deprecated" ? retirementOf(store, e.id, getNs) : undefined;
    const head =
      retired?.reason !== undefined
        ? `${formatEntity(e, ontology, readAt)}\n  retired: ${retired.reason}`
        : formatEntity(e, ontology, readAt);
    if (!v.relations) {
      emit(v, head, retired ? { ...e, retired } : e);
      return 0;
    }
    // Relations are reachable from no other command — the entity-detail screen needs them, so the
    // CLI must be able to show them too.
    const rels = (await store.neighbors(id)).filter(
      (r) => normalizeNs(r.ns) === normalizeNs(getNs),
    );
    const edges = rels.map((r) => ({
      ...r,
      dir: r.from === id ? ("out" as const) : ("in" as const),
      other: r.from === id ? r.to : r.from,
    }));
    const lines = edges.map(
      (r) => `  ${r.dir === "out" ? "->" : "<-"} ${r.type}  ${r.other}`,
    );
    emit(
      v,
      [head, lines.length ? lines.join("\n") : "  (no relations)"].join("\n"),
      { ...e, relations: edges, ...(retired ? { retired } : {}) },
    );
    return 0;
  });
}

// list / graph — the CLI half of the browse and graph screens. WEB-UI's rule is that every action
// the web tier performs stays achievable here, so these exist for parity, and --json emits the same
// shape the endpoints do (byte-for-byte, so parity is checkable and not just claimed).
const LIST_USAGE =
  "usage: yoke list [--type t] [--status s] [--limit n] [--after cursor]\n" +
  "  a whole-namespace listing; to search by words use 'yoke search <query>'";

async function cmdList(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  // A word here used to be dropped in silence: `yoke list cache` returned the entire namespace, which
  // reads as a filter that matched everything. `--bogus-flag` was already refused, so the same
  // argument was strict as a flag and ignored as a positional.
  if (positionals.length > 0) {
    console.error(`list takes no arguments\n${LIST_USAGE}`);
    return 1;
  }
  if (v.help) {
    console.log(LIST_USAGE);
    return 0;
  }
  const ns = resolveNs(v.ns, env);
  const listedAt = now();
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(ns);
    const p = await store.listEntities({
      ns,
      type: typeFilter(v.type, ontology),
      status: statusFilter(v.status),
      after: v.after,
      limit: intFlag(v.limit, "limit"),
    });
    if (p.items.length === 0) {
      emit(v, "nothing to list", p);
      return 0;
    }
    // Names, not ids, in the column a person reads to know whose record this is. The web tier has
    // resolved these since v2.5; the CLI printed the raw actor, so a corpus whose authors are person
    // records — what `--actor <person-id>` and every seeded corpus produce — was a wall of ULIDs.
    // The id stays reachable through `get` and the citation, which is where an id belongs.
    const { nameOf, prefetch } = makeActorNames(store, ontology);
    await prefetch(p.items);
    const lines = await Promise.all(
      p.items.map(
        async (e) =>
          `${e.id}  ${e.type}  ${shownStatus(e, ontology, listedAt)}  ${summarize(e, ontology)}  ${
            (await nameOf(e.provenance.actor)) ?? e.provenance.actor
          }`,
      ),
    );
    if (p.next) lines.push(`-- more: yoke list --after ${p.next}`);
    emit(v, lines.join("\n"), p);
    return 0;
  });
}

const GRAPH_USAGE =
  "usage: yoke graph [--limit n]\n" +
  "  the whole namespace; for one record's neighbourhood use 'yoke get <id> --relations'";

async function cmdGraph(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  // `graph <id>` and `graph --scope <id>` both returned the whole graph, byte for byte, with no
  // notice — an anchored view that silently answers about everything is worse than not offering one.
  if (positionals.length > 0 || v.scope !== undefined) {
    console.error(`graph is not anchored\n${GRAPH_USAGE}`);
    return 1;
  }
  if (v.help) {
    console.log(GRAPH_USAGE);
    return 0;
  }
  const ns = resolveNs(v.ns, env);
  const limit = intFlag(v.limit, "limit") ?? 300;
  return withStore(v, env, async (store) => {
    const [nodes, edges] = await Promise.all([
      store.listEntities({ ns, limit }),
      store.listRelations({ ns, limit }),
    ]);
    const truncated = nodes.next !== null || edges.next !== null;
    const lines = [
      `${nodes.items.length} nodes, ${edges.items.length} edges`,
      ...edges.items.map((r) => `  ${r.from} -${r.type}-> ${r.to}`),
    ];
    if (truncated) lines.push(`-- truncated at ${limit} (raise --limit)`);
    emit(v, lines.join("\n"), {
      anchor: null,
      nodes: nodes.items,
      edges: edges.items,
      next: { nodes: nodes.next, edges: edges.next },
      truncated,
      limit,
    });
    return 0;
  });
}

const SEARCH_USAGE =
  "usage: yoke search <query> [--type t] [--status s] [--limit n]\n" +
  '  quote a phrase: yoke search "retry budget"';

async function cmdSearch(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0];
  noExtra(positionals, 1, SEARCH_USAGE);
  if (!query) {
    console.error(SEARCH_USAGE);
    return 1;
  }
  const limit = intFlag(v.limit, "limit");
  const ns = resolveNs(v.ns, env);
  const actor = resolveActor(v, env);
  const searchedAt = now();
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(ns);
    const results = await store.search({
      text: query,
      type: typeFilter(v.type, ontology),
      // `--status` exists so this command and `/api/search` can express the same query. Without it
      // the browser could ask a question the CLI could not, which is the parity rule broken.
      status: statusFilter(v.status),
      limit,
      ns,
    });
    // The query is the subject, not just the ids: `search` records what someone was looking for,
    // which is the fact an enumeration row does not carry.
    store.logAudit({
      actor,
      action: "search",
      detail: `${query} -> ${results.map((e) => e.id).join(" ")}`,
      at: now(),
      ns,
    });
    // `inject` says "no results"; this printed a blank line, so a search that found nothing looked
    // like a command that did nothing. --json is unchanged (an empty array is already unambiguous).
    emit(
      v,
      results.length
        ? results.map((e) => formatEntity(e, ontology, searchedAt)).join("\n")
        : "no results",
      results,
    );
    return 0;
  });
}

async function cmdReview(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  const limit = intFlag(v.limit, "limit");
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(ns);
    // --stale is the OTHER queue: verified records past their type's TTL. SPEC has said since v1 that
    // viewing stale is review's job, and this command listed drafts only — so knowledge left injection
    // with nobody told. The rows carry the owner because the fix is a person, not a flag.
    if (v.stale) {
      const { items, next, scanned } = await staleEntities(
        store,
        ontology,
        now(),
        { ns, type: typeFilter(v.type, ontology), limit, after: v.after },
      );
      if (items.length === 0) {
        emit(v, `no stale records (scanned ${scanned} verified)`, []);
        return 0;
      }
      // Most-consumed first: re-confirmation effort goes to the knowledge agents are actually being
      // fed. The count is this store's audit trail — under `serve` that is the team's central trail;
      // pointed straight at a shared remote backend it is this client's own reads only.
      const ranked = rankByConsumption(
        items,
        consumptionCounts(store.listAudit({ ns })),
      );
      // This queue exists to name a person to go and ask, so an unresolved id is the column doing the
      // opposite of its job.
      const { nameOf, prefetch } = makeActorNames(store, ontology);
      await prefetch(ranked);
      const lines = await Promise.all(
        ranked.map(
          async (e) =>
            `${e.id}  ${e.type}  ${summarize(e, ontology)}  ${
              (await nameOf(e.provenance.actor)) ?? e.provenance.actor
            }  injected ${e.injections}x  last confirmed ${e.last_confirmed}`,
        ),
      );
      // The scan is bounded, so say what it covered — "3 stale" alone reads as "3 stale in the whole
      // corpus", which is a claim this walk did not make.
      lines.push(
        `-- ${ranked.length} stale among ${scanned} verified records scanned` +
          (next === null ? "" : `; more to scan: --after ${next}`),
      );
      emit(v, lines.join("\n"), ranked);
      return 0;
    }
    const drafts = (
      await store.listEntities({
        status: "draft",
        ns,
        type: typeFilter(v.type, ontology),
      })
    ).items;
    if (drafts.length === 0) {
      emit(v, "no drafts", []);
      return 0;
    }
    const { nameOf, prefetch } = makeActorNames(store, ontology);
    await prefetch(drafts);
    const lines = await Promise.all(
      drafts.map(
        async (e) =>
          `${e.id}  ${e.type}  ${summarize(e, ontology)}  ${
            (await nameOf(e.provenance.actor)) ?? e.provenance.actor
          }  ${e.provenance.occurred_at}`,
      ),
    );
    emit(v, lines.join("\n"), drafts);
    return 0;
  });
}

async function cmdVerify(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ids = v["all-drafts"]
      ? (await store.listEntities({ status: "draft", ns })).items.map(
          (e) => e.id,
        )
      : positionals;
    if (ids.length === 0) {
      console.error("usage: yoke verify <id...> [--all-drafts] [--actor a]");
      return 1;
    }
    const ts = now();
    const promoted = await verify(store, ids, actor, ts, ns);
    // Verify is THE governance act — ENTERPRISE.md calls it the most important axis in this
    // product's permission model — and the CLI is its primary interface (ROADMAP v0.2). Auditing it
    // in the web tier and not here meant the trail could not answer "who promoted this" for any
    // promotion done the normal way.
    store.logAudit({
      actor,
      action: "verify",
      detail: promoted.map((e) => e.id).join(" "),
      at: ts,
      ns,
    });
    emit(
      v,
      `verified ${promoted.length}: ${promoted.map((e) => e.id).join(" ")}`,
      promoted,
    );
    return 0;
  });
}

async function cmdDeprecate(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  if (positionals.length === 0) {
    console.error(
      'usage: yoke deprecate <id...> [--actor a] [--reason "why it was retired"]',
    );
    return 1;
  }
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    const done = await deprecate(store, positionals, actor, ts, ns);
    // Retiring knowledge changes what every future injection returns, so it belongs in the trail
    // for the same reason verify does.
    // `--reason` rides on the audit row, not on the record: verify/deprecate change status, never
    // knowledge content (see lifecycle.ts). It is the answer to the question a retired record raises
    // and could not answer — "why is this deprecated" had nowhere to be written down.
    store.logAudit({
      actor,
      action: "deprecate",
      detail: done.map((e) => e.id).join(" "),
      at: ts,
      ns,
      note: v.reason,
    });
    // What rests on it (v5.8). Retiring a record is not a repair unless the records built on it can be
    // found, and the moment of retiring is the one moment someone is looking. Read AFTER the transition
    // so a failed deprecate reports nothing, and named rather than counted — "3 records" routes nobody.
    const downstream = await downstreamOf(
      store,
      done.map((e) => e.id),
      ns,
    );
    const human = [
      `deprecated ${done.length}: ${done.map((e) => e.id).join(" ")}`,
    ];
    if (downstream.length > 0) {
      human.push(
        `${downstream.length} record(s) declared they rest on this — re-examine:`,
      );
      for (const d of downstream) human.push(`  ${label(d, ontology)}`);
    }
    emit(v, human.join("\n"), { deprecated: done, downstream });
    return 0;
  });
}

const INJECT_USAGE =
  "usage: yoke inject <query> [--include-draft] [--limit n] [--scope id] [--as-of ts]\n" +
  '  quote a phrase: yoke inject "retry budget"\n' +
  "       yoke inject --scope <id>            briefing of that working context\n" +
  "       yoke inject --scope <id> --depth 2  and what that context's context knows\n" +
  "       yoke inject <query> --as-of <ts>    what this would have injected then";

async function cmdInject(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0] ?? "";
  noExtra(positionals, 1, INJECT_USAGE);
  const asOf = instantFlag(v["as-of"], "as-of");
  // `--scope <id>` with no query is a briefing of that working context — the MCP tool and the web
  // route have always allowed it, and the CLI's require-a-query guard silently made the one front
  // adapter a human uses unable to reproduce what an agent receives (the CLI-achievable rule).
  if (!query && v.scope === undefined) {
    console.error(INJECT_USAGE);
    return 1;
  }
  // `--depth` only means anything with an anchor to walk from, and core ignores it otherwise — so
  // `inject cache --depth 99` returned byte-for-byte what `inject cache` did, and nothing said the
  // number had been dropped. A flag that silently does nothing is a wrong answer to a question the
  // caller thought they asked.
  if (v.depth !== undefined && v.scope === undefined) {
    console.error("--depth walks from an anchor: pass --scope <id> as well");
    return 1;
  }
  const limit = intFlag(v.limit, "limit");
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    // An anchor that is not a record cannot be prioritized, and the empty answer that follows looks
    // exactly like a corpus with nothing in it. The scope is the caller's own id — telling them it did
    // not resolve costs one point read.
    if (v.scope !== undefined && !(await store.getEntity(v.scope))) {
      console.error(
        `--scope is not a record: ${v.scope} — 'yoke list' shows what can be anchored on`,
      );
      return 1;
    }
    const ts = now();
    // Same default as the MCP tool and the web route: an anchored briefing is capped, a query is not.
    // Without it, `yoke inject --scope <collaboration>` dumps every record ever attached to that work.
    const briefing = v.scope !== undefined && !query;
    const { items, omitted, walk, withheld } = await inject(
      store,
      ontology,
      query,
      ts,
      {
        includeDraft: v["include-draft"],
        limit: limit ?? (briefing ? BRIEFING_LIMIT : undefined),
        ns,
        // The MCP tool has always passed a scope; the CLI never did, so the two front ends could not
        // reproduce each other's results (WEB-UI's CLI-achievable rule).
        scope: v.scope,
        // Relation hops the anchor walk takes (SPEC "Multi-hop"). 1 = the v4.0 behaviour.
        depth: intFlag(v.depth, "depth"),
        asOf,
        // Hybrid retrieval (SPEC "Hybrid retrieval"): the same env-configured embedder the gate uses,
        // so `yoke inject` and `yoke_inject` cannot retrieve differently for the same query.
        embedder: makeFetchEmbedder(env),
      },
    );
    // Injection audit (PLAN 8.4): who got what knowledge injected. Logged at the front tier — core stays pure.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "inject",
      detail: injectDetail(
        items.map((it) => it.entity.id),
        { query, scope: v.scope, asOf },
      ),
      at: ts,
      ns,
    });
    // The contradiction marker rides the line, not a footnote: `yoke conflicts` already printed these
    // pairs while injection — the thing an agent actually reads — said nothing, so six queries on the demo
    // corpus handed over both sides of a live disagreement as two equal facts.
    // Assembled from `pointer` rather than printed from `it.citation`, so the people in it can be named.
    // `pointer` exists for exactly this split: the id half is the audit pointer and stays an id, and who
    // said it is rendered for a reader. `--json` still carries core's citation string verbatim, so the
    // machine contract is untouched — this is the human line only.
    const { nameOf, prefetch } = makeActorNames(store, ontology);
    await prefetch(items.map((it) => it.entity));
    const who = async (it: (typeof items)[number]): Promise<string> => {
      const promoter = it.entity.provenance.actor;
      const authorId = it.author ?? promoter;
      const author = (await nameOf(authorId)) ?? authorId;
      if (authorId === promoter) return author;
      const confirmer = (await nameOf(promoter)) ?? promoter;
      return `${author} (confirmed by ${confirmer})`;
    };
    const lines = await Promise.all(
      items.map(
        async (it) =>
          `${pointer(it.entity)} ${await who(it)}, ${it.entity.provenance.occurred_at}  ${summarize(it.entity, ontology)}` +
          (it.conflictsWith
            ? `\n  ! contradicted by ${it.conflictsWith.join(" ")} — both are recorded, neither is settled`
            : ""),
      ),
    );
    // Never a silent slice. --json keeps the raw items array (contract unchanged), so the count goes
    // in the human output only; a script wanting everything raises --limit.
    if (omitted > 0)
      lines.push(
        `-- ${items.length} of ${items.length + omitted} on this scope (freshest first); ` +
          `the rest are reachable by querying, or raise --limit`,
      );
    // A multi-hop walk reports what it actually did, in words. `truncated` is the one that changes how
    // the output should be read: the farthest band is incomplete, so absence is not evidence.
    if (walk)
      lines.push(
        `-- walked ${walk.depth} hop(s) from the anchor, ${walk.nodes} record(s) reached` +
          (walk.truncated
            ? `; the walk hit its ${WALK_BUDGET}-node budget, so the outermost hop is incomplete`
            : ""),
      );
    // Zero hits: say why, don't imply the knowledge simply isn't there. The counts and the reasons come
    // from core (`withheld`), so the terminal, `--json` and the MCP tool now explain the same emptiness
    // — the draft-only version of this lived here and the two agent-facing paths never got it.
    // The one next action this surface can name. Losing it would be a regression: it is the sentence
    // that taught readers the gate exists ("review with 'yoke review'").
    //
    // The same sentence rides a PARTIAL answer, where it matters more: a full page of loosely related
    // records reads as "that is everything we know", and the record that answered the question can be
    // one day past its TTL. The lead-in differs because the reader's next move does — "no verified
    // knowledge" is the answer; "also held back" is a footnote on an answer they already have.
    const reasonLine = withheld
      ? `${items.length ? "-- also held back:" : "no verified knowledge —"} ` +
        describeWithheld(withheld) +
        (withheld.draft > 0 ? " — review with 'yoke review'" : "")
      : "no results";
    if (items.length && withheld) lines.push(reasonLine);
    const human = items.length ? lines.join("\n") : reasonLine;
    // Under --json stdout stays the raw items array (contract unchanged, and a shape that alternates
    // between array and object is worse than a silent one). The reason goes to stderr, where a script
    // ignores it and the person debugging the script reads it.
    if (v.json && withheld) console.error(reasonLine);
    emit(v, human, items);
    return 0;
  });
}

// history (PLAN 8.4): the append-only version rows ARE the change audit — this just exposes them.
const HISTORY_USAGE = "usage: yoke history <id>";

async function cmdHistory(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const id = positionals[0];
  noExtra(positionals, 1, HISTORY_USAGE);
  if (!id) {
    console.error(HISTORY_USAGE);
    return 1;
  }
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(resolveNs(v.ns, env));
    // Core's helper, not `store.listHistory` — that extension is synchronous and therefore absent on a
    // remote backend (SPEC "Remote backends"). `listVersions` feature-detects it and otherwise walks
    // `getEntity(id, version)`, so this command works on every backend.
    const versions = await listVersions(store, id);
    if (versions.length === 0) {
      console.error(`not found: ${id}`);
      return 1;
    }
    // The retirement reason belongs on the version that IS the retirement. `deprecate --reason` has
    // stored it since it was added, on the audit row rather than the record (a governance act's
    // property, not knowledge content) — and the web read it back while `get`, `history` and the text
    // `audit` did not, so the answer to "why is this deprecated" was reachable only through
    // `audit --json`. The question the flag exists to answer is asked here.
    const retired = retirementOf(store, id, resolveNs(v.ns, env));
    // A version's actor is who wrote THAT version — the author on v1, the promoter on a verify. Both are
    // people and both were printed as ids, on the one screen whose job is "who changed what, when".
    // Resolved in one batch, then read synchronously so the row builder below stays a plain map.
    const { nameOf, prefetch } = makeActorNames(store, ontology);
    await prefetch(versions);
    const names = new Map(
      await Promise.all(
        [...new Set(versions.map((e) => e.provenance.actor))].map(
          async (a) => [a, await nameOf(a)] as const,
        ),
      ),
    );
    const lines = versions.map((e) => {
      const base = `v${e.version}  ${e.status}  ${names.get(e.provenance.actor) ?? e.provenance.actor}  ${e.last_confirmed}  ${summarize(e, ontology)}`;
      return e.status === "deprecated" && retired?.reason
        ? `${base}\n    reason: ${retired.reason}`
        : base;
    });
    emit(
      v,
      lines.join("\n"),
      retired?.reason ? { versions, retired: { ...retired } } : versions,
    );
    return 0;
  });
}

async function cmdAudit(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const events = store.listAudit({
      since: instantFlag(v.since, "since"),
      // The same flag `export` uses, here as the closed end of a window. Both bounds inclusive.
      until: instantFlag(v.until, "until"),
      ns,
      limit: intFlag(v.limit, "limit"),
    });
    if (v.shape) return emitShapes(v, events);
    const lines = events.map(
      (e) => `${e.at}  ${e.actor}  ${e.action}  ${e.detail}`,
    );
    emit(v, events.length ? lines.join("\n") : "no audit events", events);
    return 0;
  });
}

/** `yoke audit --shape` — the workload composition of what models were actually given.
 *
 * Counts `inject` only: `inject_preview` is a human looking at a screen, and mixing the two would
 * answer "what do people click" when the question is "what do agents ask" (docs/RESEARCH.md §5).
 * The other actions are counted too but only as a skipped total, so the denominator is never silent. */
function emitShapes(v: Values, events: AuditEvent[]): number {
  const counts = { anchored: 0, briefing: 0, plain: 0 };
  let asOf = 0;
  let previews = 0;
  let other = 0;
  for (const e of events) {
    if (e.action === "inject_preview") previews++;
    else if (e.action !== "inject") other++;
    else {
      const s = injectShape(e.detail);
      counts[s.shape]++;
      if (s.asOf) asOf++;
    }
  }
  const total = counts.anchored + counts.briefing + counts.plain;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const human = [
    `inject rows: ${total}`,
    ...Object.entries(counts).map(
      ([k, n]) => `  ${k.padEnd(9)} ${String(n).padStart(5)}  ${pct(n)}%`,
    ),
    `  as-of     ${String(asOf).padStart(5)}  ${pct(asOf)}%  (orthogonal — also counted above)`,
    `skipped: ${previews} inject_preview, ${other} other`,
  ].join("\n");
  emit(v, human, { total, ...counts, asOf, skipped: { previews, other } });
  return 0;
}

/**
 * `yoke overview` — the shape of the whole corpus (SPEC "Global aggregation").
 *
 * The one question no `inject` can answer at any limit: retrieval returns a top-k of a query, and this
 * is about the whole. Structure only, never a summary — a summary of knowledge is a claim nobody
 * verified, and this document refuses synthesis.
 */
async function cmdOverview(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const top = intFlag(v.limit, "limit");
    const ts = now();
    const o = await overview(store, ontology, ts, { ns, top });
    // Same audit row the MCP tool writes: a hub line carries a record's own text, and SPEC's audit
    // table says "the same actions are written wherever the act happens" — this adapter was the one
    // place `overview` happened silently.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "overview",
      detail: `overview -> ${o.hubs.map((h) => h.entity.id).join(" ")}`,
      at: ts,
      ns,
    });
    // Types with nothing in them are noise on a screen whose job is showing what IS here.
    const typeRows = Object.entries(o.entities.byType)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([type, c]) => {
        const parts = (["verified", "draft", "stale", "deprecated"] as const)
          .filter((k) => c[k] > 0)
          .map((k) => `${c[k]} ${k}`);
        return `  ${type.padEnd(14)} ${parts.join(", ")}`;
      });
    const relRows = Object.entries(o.relations.byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `  ${type.padEnd(14)} ${n}`);
    // Hubs and authors are resolved to something readable: a ULID is never what a person reads for
    // meaning, and `summarize` is the same renderer every other command uses.
    const hubRows = o.hubs.map(
      (h) =>
        `  ${String(h.degree).padStart(4)}  ${h.entity.type.padEnd(13)} ${summarize(h.entity, ontology)}`,
    );
    const authorRows = o.authors.map(
      (a) => `  ${String(a.verified).padStart(4)}  ${a.actor}`,
    );
    const human = [
      `${o.entities.total} records, ${o.relations.total} relations${ns ? ` in ${ns}` : ""}`,
      "",
      "by type",
      ...(typeRows.length ? typeRows : ["  (none)"]),
      "",
      "relations",
      ...(relRows.length ? relRows : ["  (none)"]),
      "",
      "most connected (authorship and rosters excluded — they connect everything)",
      ...(hubRows.length ? hubRows : ["  (none)"]),
      "",
      "verified knowledge by author (from authored_by, not who promoted it)",
      ...(authorRows.length ? authorRows : ["  (none)"]),
    ].join("\n");
    emit(v, human, o);
    return 0;
  });
}

async function cmdConflicts(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(ns);
    const rels = (await store.listRelations({ type: "conflicts_with", ns }))
      .items;
    if (rels.length === 0) {
      emit(v, "no conflicts", []);
      return 0;
    }
    // Join each pair's two entity summaries onto one line (resolution is via verify/deprecate — no dedicated command).
    // getEntity is id-based and not ns-filtered, so each resolved side is re-checked against ns.
    const inNs = (e: Entity | null) =>
      e && normalizeNs(e.ns) === normalizeNs(ns) ? e : null;
    const items = await Promise.all(
      rels.map(async (r) => {
        const from = inNs(await store.getEntity(r.from));
        const to = inNs(await store.getEntity(r.to));
        return { relation: r, from, to };
      }),
    );
    const lines = items.map(({ relation, from, to }) => {
      const side = (e: Entity | null, id: string) =>
        e
          ? `${e.id} [${e.status}] ${summarize(e, ontology)}`
          : `${id} (missing)`;
      return `${relation.id}\n  ${side(from, relation.from)}\n  <-> ${side(to, relation.to)}`;
    });
    emit(v, lines.join("\n"), items);
    return 0;
  });
}

// rename-type — the upgrade path for a database written before an ontology type was renamed.
// Without it a rename is only half a rename: the code says one thing and every stored row says the
// other, and `yoke list --type <new>` answers nothing on a database that is full of the old name.
async function cmdRenameType(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [from, to] = positionals;
  noExtra(positionals, 2, "usage: yoke rename-type <from> <to>");
  if (!from || !to) {
    console.error(
      "usage: yoke rename-type <from> <to>\n" +
        "  renames an ontology type in the declaration and in every stored row",
    );
    return 1;
  }
  if (from === to) {
    console.error("rename-type: from and to are the same name");
    return 1;
  }
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    if (!requireOntology(store, ns, v, env)) return 1;
    const rows = await store.renameType(from, to, ns);
    if (rows === 0) {
      // Not an error: nothing carried that name, so the database is already where the caller wants
      // it. Saying so beats an exit code that reads like a failure.
      emit(v, `no rows carried type "${from}" — nothing to rename`, {
        from,
        to,
        rows: 0,
      });
      return 0;
    }
    // The one mutation the append-only version history cannot record, because it rewrites those
    // very rows (see SqliteStorage.renameType). This row is the only trace it leaves.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "rename_type",
      detail: `${from} -> ${to}`,
      at: now(),
      ns,
    });
    emit(v, `renamed type "${from}" to "${to}" — ${rows} rows rewritten`, {
      from,
      to,
      rows,
    });
    return 0;
  });
}

// backfill — the upgrade path for databases written before authorship became a graph edge.
// Those entities carry provenance only in their stored field, so a person anchor (persona) cannot
// see them. Re-derives the missing authored_by edges through the gate, attributed to the recorded
// author rather than whoever runs the backfill. Idempotent: a second run creates nothing.
async function cmdBackfill(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  const limit = intFlag(v.limit, "limit");
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    // The other repair: the vector index rather than the authorship graph. Same command because both
    // are "re-derive something that was computed from knowledge", and both are idempotent.
    if (v.embeddings) {
      const { scanned, embedded, skipped, next } = await backfillEmbeddings(
        store,
        {
          embedder: makeFetchEmbedder(env),
          ns,
          limit,
          after: v.after,
          rebuild: v.rebuild,
        },
      );
      const lines = [
        `scanned ${scanned} entities, embedded ${embedded}, skipped ${skipped}`,
      ];
      // Skipped everything means the provider is not configured — the single most likely reason
      // someone runs this and sees nothing happen.
      if (skipped > 0 && embedded === 0)
        lines.push(
          "nothing was embedded: no embedding provider answered. " +
            "Set YOKE_EMBED_URL and YOKE_EMBED_MODEL (see README) and run this again",
        );
      // The walk is bounded, so an unfinished scan is said rather than implied.
      if (next !== null) lines.push(`more to scan: --after ${next}`);
      emit(v, lines.join("\n"), { scanned, embedded, skipped, next });
      return 0;
    }
    const { scanned, created } = await backfillAuthorship(
      store,
      ontology,
      now(),
      { ns },
    );
    emit(v, `scanned ${scanned} entities, added ${created} authorship edges`, {
      scanned,
      created,
    });
    return 0;
  });
}

const ONTOLOGY_USAGE = "usage: yoke ontology <list|add-type <json-file>>";

async function cmdOntology(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [sub, file] = positionals;
  // Per subcommand: `list` takes none, `add-type` takes one. A single allowance of 2 let
  // `ontology list extra` through, which is the same silent drop this guard exists to stop.
  noExtra(positionals, sub === "list" ? 1 : 2, ONTOLOGY_USAGE);
  const ns = resolveNs(v.ns, env);
  if (sub === "list") {
    return withStore(v, env, async (store) => {
      const defs = store.loadOntology(ns);
      // The attributes, not just the type names. Every journey through this CLI failed its first `add`
      // and learned the shape of the type from the rejections: `ontology list` printed the name, the
      // kind and the TTL, and the schema it was holding was reachable only through `--json`. The one
      // screen whose job is "what can I record" left out what a record needs.
      const lines = defs.map((d) => {
        const attrs = Object.entries(d.attrs);
        const req = attrs.filter(([, a]) => a.required).map(([k]) => k);
        const opt = attrs.filter(([, a]) => !a.required).map(([k]) => k);
        return (
          `${d.name}  ${d.kind}  ttl=${d.ttl_days ?? "∞"}` +
          (req.length ? `  requires: ${req.join(", ")}` : "") +
          (opt.length ? `  optional: ${opt.join(", ")}` : "")
        );
      });
      emit(v, lines.join("\n"), defs);
      return 0;
    });
  }
  if (sub === "add-type") {
    if (!file) {
      console.error("usage: yoke ontology add-type <json-file>");
      return 1;
    }
    let def: TypeDef;
    try {
      def = JSON.parse(readFileSync(file, "utf8")) as TypeDef;
    } catch (e) {
      console.error(`cannot read type def: ${(e as Error).message}`);
      return 1;
    }
    return withStore(v, env, async (store) => {
      // No initialized-ontology requirement here: add-type IS how a fresh
      // (e.g. shard tenant) ontology gets seeded — requiring one is a chicken-and-egg.
      // An existing name means a new version = a migration (same append-only model as entities).
      // ns targets a tenant ontology (overlaid on the shared base); omitted = shared.
      await store.saveOntology([def], ns);
      emit(v, `saved type: ${def.name}`, def);
      return 0;
    });
  }
  console.error(ONTOLOGY_USAGE);
  return 1;
}

/** Shared connect tail: route any connector through ingest (draft staging, idempotent external_id). */
async function runIngest(
  connector: Connector,
  v: Values,
  env: Env,
): Promise<number> {
  const actor = resolveActor(v, env);
  // `--ns` was parsed and then dropped on this whole path: `yoke --ns tenantx connect notes <dir>`
  // reported "added 2" and put both records in the SHARED namespace, where a `--ns tenantx` search
  // could not find them. The namespace is the tenant isolation unit (ENTERPRISE.md) and this is the
  // bulk entry point, so it was the largest way to file knowledge in the wrong tenant. `requireOntology`
  // took `undefined` too, so a tenant schema was not being consulted either.
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const { added, skipped } = await ingest(
      store,
      ontology,
      connector,
      actor,
      now(),
      instantFlag(v.since, "since"),
      ns,
    );
    emit(v, `added ${added}, skipped ${skipped}`, { added, skipped });
    return 0;
  });
}

async function cmdConnect(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const source = positionals[0];
  if (source === "rdb") return cmdConnectRdb(v, env);
  if (source === "slack") {
    if (!v.channel) {
      console.error(
        "usage: yoke connect slack --channel C123 [--since ts] (SLACK_TOKEN env required)",
      );
      return 1;
    }
    if (!env.SLACK_TOKEN) {
      console.error("SLACK_TOKEN environment variable is required");
      return 1;
    }
    return runIngest(
      makeSlackConnector({ channel: v.channel, token: env.SLACK_TOKEN }),
      v,
      env,
    );
  }
  if (source === "notes") {
    const dir = positionals[1];
    if (!dir) {
      console.error("usage: yoke connect notes <dir> [--actor a]");
      return 1;
    }
    return runIngest(makeNotesConnector({ dir }), v, env);
  }
  if (source !== "github-pr" || !v.repo) {
    console.error(
      "usage: yoke connect <github-pr --repo owner/name | slack --channel C123 | notes <dir> | rdb --mapping f.json> [--since ts] [--actor a]",
    );
    return 1;
  }
  return runIngest(
    makeGithubPrConnector({ repo: v.repo, token: env.GITHUB_TOKEN }),
    v,
    env,
  );
}

// connect rdb (PLAN 8.3): read-map an existing RDB into verified entities. See rdb-mapping.ts for the
// design exception (bypasses draft staging, still validates against the ontology).
async function cmdConnectRdb(v: Values, env: Env): Promise<number> {
  if (!v.mapping) {
    console.error(
      "usage: yoke connect rdb --mapping <file.json> [--dsn postgres://...] [--sqlite <path>]",
    );
    return 1;
  }
  let mapping: MappingSpec[];
  try {
    mapping = JSON.parse(readFileSync(v.mapping, "utf8")) as MappingSpec[];
  } catch (e) {
    console.error(`cannot read mapping: ${(e as Error).message}`);
    return 1;
  }

  // Source driver: --dsn → Postgres (pg, lazy-imported so the sqlite path never needs pg);
  // --sqlite → local better-sqlite3 file (no server needed for local/demo use).
  let query: (sql: string) => Promise<Record<string, unknown>[]>;
  let closeSrc = (): void => {};
  if (v.dsn) {
    const { makePgQuery } = await import("../../connectors/rdb-pg.js");
    query = makePgQuery(v.dsn);
  } else if (v.sqlite) {
    const src = new Database(v.sqlite, { readonly: true });
    query = async (sql) => src.prepare(sql).all() as Record<string, unknown>[];
    closeSrc = () => src.close();
  } else {
    console.error("connect rdb requires --dsn or --sqlite");
    return 1;
  }

  const connector = makeRdbMappingConnector({ query, mapping });
  try {
    const ns = resolveNs(v.ns, env);
    return await withStore(v, env, async (store) => {
      const ontology = requireOntology(store, ns, v, env);
      if (!ontology) return 1;
      const { added, updated, skipped } = await ingestMapped(
        store,
        ontology,
        connector,
        now(),
        ns,
      );
      emit(v, `mapped ${added} added, ${updated} updated, ${skipped} skipped`, {
        added,
        updated,
        skipped,
      });
      return 0;
    });
  } finally {
    closeSrc();
  }
}

async function cmdPersona(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  if (v.check !== undefined) return await cmdPersonaCheck(v, env);
  const id = positionals[0];
  if (!id) {
    console.error(
      "usage: yoke persona <person-id> [--out dir]\n       yoke persona --check <SKILL.md>",
    );
    return 1;
  }
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const person = await store.getEntity(id);
    const ts = now();
    // The anchor check lives in core (a fact id passed the existence check this used to do alone), so
    // both refusals — not found, and not a person — arrive as one exception.
    let result: PersonaResult;
    try {
      result = await personaQuery(store, ontology, id, ts, { ns });
    } catch (e) {
      if (e instanceof NotAPerson) {
        console.error(
          `${e.message} — 'yoke list --type person' lists the anchors`,
        );
        return 1;
      }
      throw e;
    }
    if (!person) return 1;
    const md = renderPersonaSkill(person, result, ts);
    // fs lives only in the CLI tier (core produces only a string).
    const outDir = join(v.out ?? ".", `persona-${safeName(id)}`);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, "SKILL.md");
    writeFileSync(file, md);
    const injected = [...result.decisions, ...result.facts];
    // A persona read IS an injection — same knowledge, same citations — and this one also writes a
    // SKILL.md that goes into someone's prompt. Its MCP and web twins both audit it; this path was
    // the hole left when that was fixed in the web tier and the CLI was never checked.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "persona",
      detail: `${id} -> ${injected.map((e) => e.id).join(" ")}`,
      at: ts,
      ns,
    });
    const sources = injected.length;
    emit(v, `saved: ${file}\nsource knowledge: ${sources}`, {
      path: file,
      sources,
    });
    return 0;
  });
}

/**
 * `yoke persona --check <SKILL.md>` — audit an exported snapshot against the store now (SPEC persona
 * "Identifying one"). The export has recorded its source versions since v1 and nothing read them back.
 *
 * Exit 1 when any source moved, so this works as a CI or pre-commit gate: the point of a snapshot that
 * names its sources is that something other than a person can read them. fs stays in this tier — core
 * takes the parsed header, never a path.
 */
async function cmdPersonaCheck(v: Values, env: Env): Promise<number> {
  const file = v.check as string;
  let md: string;
  try {
    md = readFileSync(file, "utf8");
  } catch {
    console.error(`cannot read: ${file}`);
    return 1;
  }
  const header = parsePersonaSources(md);
  if (!header.recognized) {
    console.error(
      `not an exported persona (no "Source knowledge" line): ${file}`,
    );
    return 1;
  }
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const checks = await checkPersonaSources(
      store,
      ontology,
      header.sources,
      now(),
      { ns },
    );
    const moved = checks.filter((c) => c.verdict !== "ok");
    const lines = checks.map(
      (c) =>
        // Verdict first, because a reader scans this column and stops at the first thing that is not ok.
        // Then the record in words: a report a person is meant to act on cannot be a list of ULIDs.
        `${c.verdict.padEnd(11)}${label(c, ontology)}${
          c.verdict === "outdated" ? `  (v${c.version} → v${c.current})` : ""
        }`,
    );
    if (header.unparsed.length > 0)
      lines.push(
        `unreadable  ${header.unparsed.join(", ")} — hand-edited header?`,
      );
    lines.push(
      moved.length === 0
        ? `${checks.length} sources, all current`
        : `${moved.length} of ${checks.length} sources moved — re-export with: yoke persona <person> --out <dir>`,
    );
    emit(v, lines.join("\n"), {
      file,
      sources: checks,
      unparsed: header.unparsed,
      moved: moved.length,
    });
    // Unparsed tokens are a failure too: a source that cannot be read is not a source that is fine.
    return moved.length > 0 || header.unparsed.length > 0 ? 1 : 0;
  });
}

// ui (PLAN 9.x): the governance workbench. Server keeps the process alive until SIGINT.
async function cmdUi(v: Values, env: Env): Promise<number> {
  const port = intFlag(v.port, "port", 0) ?? 4800;
  const server = await runUi(
    resolveDb(v, env),
    port,
    env,
    resolveNs(v.ns, env),
    resolveShards(v, env),
    v.host ?? env.YOKE_HOST,
  );
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}

// serve (PLAN-V2 10.2): UI + JSON API + remote MCP on one port. Auth (10.3/10.4) is opt-in.
async function cmdServe(v: Values, env: Env): Promise<number> {
  const port = intFlag(v.port, "port", 0) ?? 4800;
  const server = await runServe(resolveDb(v, env), port, env, {
    auth: v.auth,
    ns: resolveNs(v.ns, env),
    replicaOf: v["replica-of"],
    refreshSec:
      v["refresh-sec"] === undefined ? undefined : Number(v["refresh-sec"]),
    shards: resolveShards(v, env),
    host: v.host ?? env.YOKE_HOST,
  });
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}

// token (PLAN-V2 10.3): API tokens for serve-mode Bearer auth. Secret is shown once on create.
const TOKEN_CREATE_USAGE =
  'usage: yoke token create --name <n> --scopes "<ns>:read,<ns>:write[,<ns>:<type>:verify,<ns>:admin]"\n' +
  "  scope = action | namespace:action | namespace:type:action\n" +
  "  actions: read, write, verify (promote/retire), admin (issue credentials)\n" +
  "  an action with NO namespace grants every tenant — name the namespace unless you mean that";

async function cmdToken(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [sub] = positionals;
  if (sub === "create") {
    if (!v.name || !v.scopes) {
      console.error(TOKEN_CREATE_USAGE);
      return 1;
    }
    const scopes = v.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Validated at issue time, because a token whose scopes are nonsense is indistinguishable from a
    // working one until someone tries to use it. Measured: `--scopes "reed,wrote"` and `--scopes teamA`
    // were both accepted, listed by `token list` like any other credential, and then 403'd on
    // everything; `--scopes ","` produced a token with a blank scope column and no warning anywhere.
    // The parser that decides what a scope MEANS is the right thing to ask what one IS.
    const bad = scopes.filter((raw) => parseScope(raw) === null);
    if (bad.length > 0 || scopes.length === 0) {
      const why =
        scopes.length === 0
          ? "--scopes is empty: a credential with no scope can do nothing"
          : `not a scope: ${bad.join(", ")}`;
      console.error(`${why}\n${TOKEN_CREATE_USAGE}`);
      return 1;
    }
    return withStore(v, env, async (store) => {
      const { token } = store.createToken({
        name: v.name as string,
        scopes,
        created_at: now(),
      });
      // The plaintext secret is only ever returned here — store it now (only the hash is persisted).
      // Human output used to be the bare secret and nothing else: the one moment an admin can record
      // what this credential is for said neither its name nor its scopes nor that it is shown once.
      // A wildcard-ns scope is called out, because `read` reads EVERY tenant and both the usage string
      // and `serve`'s own refusal message teach exactly that spelling.
      const wildcard = scopes.filter((raw) => parseScope(raw)?.ns === null);
      emit(
        v,
        [
          token,
          `  shown once — this is the only time the secret is printed`,
          `  name: ${v.name}   scopes: ${scopes.join(", ")}`,
          ...(wildcard.length > 0
            ? [
                `  note: ${wildcard.join(", ")} ${wildcard.length === 1 ? "has" : "have"} no namespace, ` +
                  `so ${wildcard.length === 1 ? "it grants" : "they grant"} every tenant — ` +
                  `write '<namespace>:${parseScope(wildcard[0])?.action}' to scope it to one`,
              ]
            : []),
        ].join("\n"),
        { name: v.name, scopes, token },
      );
      return 0;
    });
  }
  if (sub === "list") {
    return withStore(v, env, async (store) => {
      const toks = store.listTokens();
      // A wildcard-ns scope is marked: it is the difference between a credential for one tenant and one
      // for all of them, and this listing is the only answer to "who can reach what right now".
      const lines = toks.map(
        (t) =>
          `${t.name}  ${t.scopes.join(",")}  ${t.created_at}` +
          (t.scopes.some((raw) => parseScope(raw)?.ns === null)
            ? "  [all namespaces]"
            : ""),
      );
      emit(v, toks.length ? lines.join("\n") : "no tokens", toks);
      return 0;
    });
  }
  if (sub === "revoke") {
    const name = positionals[1];
    if (!name) {
      console.error("usage: yoke token revoke <name>");
      return 1;
    }
    return withStore(v, env, async (store) => {
      const removed = store.revokeToken(name);
      if (!removed) {
        console.error(`no such token: ${name}`);
        return 1;
      }
      emit(v, `revoked: ${name}`, { name, revoked: true });
      return 0;
    });
  }
  console.error("usage: yoke token <create|list|revoke> ...");
  return 1;
}

// backup (PLAN-V2 11.1): online WAL-safe snapshot to a fresh file.
const BACKUP_USAGE =
  "usage: yoke backup <dest.db>\n" +
  "  --out belongs to 'yoke export'; backup takes the destination as its argument";

async function cmdBackup(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const dest = positionals[0];
  noExtra(positionals, 1, BACKUP_USAGE);
  if (!dest) {
    console.error(BACKUP_USAGE);
    return 1;
  }
  const db = resolveDb(v, env);
  // The same guard `restore` has, for the same destruction. A command called "backup" was performing an
  // unconfirmed, unrecoverable overwrite: `yoke --db a.db backup ./b.db` replaced every record in b.db
  // and printed success, while `yoke --db b.db restore ./a.db` — the identical outcome — refused without
  // `--force`. Measured on a database whose only copy of its knowledge was the file being written over.
  //
  // Named with the destination and the flag, because the ordinary case is a typo'd path rather than a
  // change of mind.
  if (existsSync(dest) && !v.force) {
    console.error(
      `refusing to overwrite existing file: ${dest} (use --force to replace it)`,
    );
    return 1;
  }
  return withStore(v, env, async (store) => {
    // A backup of a damaged database is not a backup. It copied without complaint, and the result passed
    // `restore`'s validation — so the one command an operator runs to protect themselves propagated the
    // corruption and told them they were safe.
    const check = store.integrityCheck?.();
    if (check !== undefined && check !== "ok") {
      console.error(
        `${db} is damaged and was not backed up: ${check}\n` +
          "a copy of a damaged database is not a backup — recover this file first",
      );
      return 1;
    }
    await store.backupTo(dest);
    emit(v, `backed up ${db} -> ${dest}`, { db, dest });
    return 0;
  });
}

// restore (PLAN-V2 11.1): safety-checked copy of a backup back over the working DB. Refuses to clobber
// an existing DB without --force, and validates the source is a real yoke DB first. Uses .backup() to
// write a clean consistent file (WAL-safe on both ends) rather than a raw file copy.
async function cmdRestore(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const src = positionals[0];
  noExtra(positionals, 1, "usage: yoke restore <src.db> [--force]");
  if (!src) {
    console.error("usage: yoke restore <src.db> [--force]");
    return 1;
  }
  if (resolveShards(v, env)) {
    console.error(
      "restore is a per-shard operation: run it against each shard's own db",
    );
    return 1;
  }
  const dest = resolveDb(v, env);
  if (existsSync(dest) && !v.force) {
    console.error(
      `refusing to overwrite existing DB: ${dest} (use --force to replace)`,
    );
    return 1;
  }
  // Validate: a real yoke DB has a seeded ontology and the yoke:system bootstrap person.
  try {
    const s = new Database(src, { readonly: true });
    try {
      // Structure first. The two checks below read `ontology_types` and one `entities` row, and on a
      // damaged file those pages are usually intact — so a corrupt backup passed validation, was copied
      // over a healthy database, and reported success. Measured: a file whose `integrity_check` reported
      // "Offset 63351 out of range" restored with exit 0 and destroyed a 251-record database.
      //
      // `quick_check` rather than `integrity_check`: it verifies page structure without the full index
      // cross-check, which is the part that costs O(database) on a large file. What it catches is the
      // class that matters here — a file that cannot be read correctly at all.
      const check = (
        s.pragma("quick_check", { simple: true }) as string
      ).toLowerCase();
      if (check !== "ok") {
        console.error(
          `${src} is damaged and was not restored: ${check}\n` +
            "restoring it would destroy the database it was meant to repair",
        );
        return 1;
      }
      const { n } = s
        .prepare("SELECT COUNT(*) AS n FROM ontology_types")
        .get() as { n: number };
      const sys = s
        .prepare("SELECT 1 FROM entities WHERE id = ? LIMIT 1")
        .get("yoke:system");
      if (n === 0 || !sys) {
        console.error(
          `not a valid yoke DB: ${src} (missing ontology_types or yoke:system)`,
        );
        return 1;
      }
    } finally {
      s.close();
    }
  } catch (e) {
    console.error(`not a valid yoke DB: ${src} (${(e as Error).message})`);
    return 1;
  }
  // Drop any stale WAL/SHM sidecar of the dest so the fresh copy can't be corrupted by leftover journal.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(dest + suffix);
    } catch {
      // nothing to clean
    }
  }
  const s = new Database(src, { readonly: true });
  try {
    await s.backup(dest);
  } finally {
    s.close();
  }
  emit(v, `restored ${src} -> ${dest}`, { src, dest });
  return 0;
}

// export (PLAN-V2 11.1 PITR-lite): reconstruct DB state as of --until into a new file. See
// exportUntil in storage-sqlite for the precision caveat (created_at = server-clock ingestion time).
async function cmdExport(v: Values, env: Env): Promise<number> {
  if (!v.until || !v.out) {
    console.error("usage: yoke export --until <iso-ts> --out <new.db>");
    return 1;
  }
  // Checked before the copy, not inside the report of it: an unparseable instant compares false
  // against every row, so `exportUntil("yesterday")` writes a file and calls it a point in time.
  const until = instantFlag(v.until, "until") as string;
  return withStore(v, env, async (store) => {
    await store.exportUntil(until, v.out as string);
    emit(v, `exported state as of ${until} -> ${v.out}`, {
      until,
      out: v.out,
    });
    return 0;
  });
}

export async function runCli(
  argv: string[],
  env: Env = process.env,
): Promise<number> {
  // Bare `yoke --version` prints the package version. Handled before parseArgs
  // because --version is also `get`'s value-taking option (--version <n>).
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(version);
    return 0;
  }
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    // node's own parser messages, translated into this tool's voice where they are unhelpful. Two are
    // worth the lines: a negative number reads as "Option '--limit' argument is ambiguous", which names
    // no fix; and an unknown flag reads as a paragraph about `--` that suggests passing the typo as a
    // positional argument. `--dept` for `--depth` deserves the same near-miss correction a mistyped
    // COMMAND already gets.
    const msg = (e as Error).message;
    const flag = /'(--[\w-]+)'/.exec(msg)?.[1];
    const bare = flag?.replace(/^--/, "");
    if (/ambiguous/i.test(msg) && flag) {
      console.error(
        `${flag} looks like it was given a negative value. Counts are positive; ` +
          `write ${flag} <n>, and use '${flag}=-1' only if you really mean a literal "-1".`,
      );
      return 1;
    }
    if (/[Uu]nknown option/.test(msg) && bare) {
      const near = Object.keys(OPTIONS).filter(
        (o) => editDistance(o, bare) <= (bare.length <= 4 ? 1 : 2),
      );
      console.error(
        `unknown option: ${flag}` +
          (near.length > 0
            ? ` — did you mean ${near.map((o) => `'--${o}'`).join(" or ")}?`
            : `\nrun 'yoke help' for the options every command takes`),
      );
      return 1;
    }
    console.error(msg);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  // `--help` with no command is the overview; WITH a command it is that command's usage. It used to
  // print the overview either way, so `yoke list --help` answered a different question than the one
  // asked — and for a command with no required arguments the "run it with missing args" convention
  // never fires, leaving `--type` and `--status` documented nowhere a reader would look.
  if (
    command === "help" ||
    command === undefined ||
    (values.help && !command)
  ) {
    console.log(usage());
    return 0;
  }
  try {
    switch (command) {
      case "init":
        return await cmdInit(values, env);
      case "link":
        return await cmdLink(rest, values, env);
      case "add":
        return await cmdAdd(rest, values, env);
      case "get":
        return await cmdGet(rest, values, env);
      case "list":
        return await cmdList(rest, values, env);
      case "graph":
        return await cmdGraph(rest, values, env);
      case "search":
        return await cmdSearch(rest, values, env);
      case "review":
        return await cmdReview(values, env);
      case "verify":
        return await cmdVerify(rest, values, env);
      case "deprecate":
        return await cmdDeprecate(rest, values, env);
      case "inject":
        return await cmdInject(rest, values, env);
      case "history":
        return await cmdHistory(rest, values, env);
      case "audit":
        return await cmdAudit(values, env);
      case "conflicts":
        return await cmdConflicts(values, env);
      case "overview":
        return await cmdOverview(values, env);
      case "ontology":
        return await cmdOntology(rest, values, env);
      case "connect":
        return await cmdConnect(rest, values, env);
      case "persona":
        return await cmdPersona(rest, values, env);
      case "backfill":
        return await cmdBackfill(values, env);
      case "rename-type":
        return await cmdRenameType(rest, values, env);
      case "ui":
        return await cmdUi(values, env);
      case "serve":
        return await cmdServe(values, env);
      case "token":
        return await cmdToken(rest, values, env);
      case "backup":
        return await cmdBackup(rest, values, env);
      case "restore":
        return await cmdRestore(rest, values, env);
      case "export":
        return await cmdExport(values, env);
      case "mcp":
        // Start the stdio server — does not resolve until the connection closes (keeps the process alive).
        await runMcp(resolveDb(values, env), env, resolveShards(values, env));
        return 0;
      default:
        // A near miss gets the correction instead of 25 lines of overview. Every mistyped command in a
        // usability pass was one edit away (`inejct`, `ad`, `lst`), and a full help dump for a
        // transposition buries the answer in the noise it caused.
        {
          const near = COMMANDS.filter(
            (c) => editDistance(c, command) <= (command.length <= 4 ? 1 : 2),
          );
          console.error(
            near.length > 0
              ? `unknown command: ${command} — did you mean ${near.map((c) => `'${c}'`).join(" or ")}?`
              : `unknown command: ${command}\n\n${usage()}`,
          );
        }
        return 1;
    }
  } catch (e) {
    // A caller error is already a sentence addressed to the reader — print it and nothing else.
    if (e instanceof UsageError) {
      console.error((e as Error).message);
      return 1;
    }
    // Everything else reaching here is a failure, and the bare message is usually the storage engine's:
    // "datatype mismatch", "database disk image is malformed", "file is not a database", "NOT NULL
    // constraint failed: ontology_types.name". None of them names the file it happened to or what to do
    // next, in a tool whose own style is "not initialized: <path> — run 'yoke init' first". Naming the
    // database is the one piece of context this layer always has, and the corruption case gets the
    // command that exists for it.
    const msg = (e as Error).message;
    const db = resolveDb(values, env);
    const corrupt =
      /malformed|not a database|file is encrypted|disk image/i.test(msg);
    console.error(
      corrupt
        ? `${db}: ${msg}\nthis file is not a readable yoke database — restore a backup with 'yoke restore <backup.db> --force'`
        : `${command ?? "yoke"} failed on ${db}: ${msg}`,
    );
    return 1;
  }
}

/**
 * Load `.env` from the working directory, if there is one. Node's own parser, no dependency.
 *
 * Returns whether a file was read, which is for the test — nothing in the product branches on it. A
 * missing `.env` is the normal case, not a warning: the local path has to work with no configuration
 * at all (invariant 4). Unreadable and "is a directory" are the same answer for the same reason.
 *
 * **Real environment variables win.** `process.loadEnvFile` does not overwrite a variable that is
 * already set (measured, not assumed — see the test), so a shell export or a CI secret always beats
 * the file and no deployment can be quietly reconfigured by a `.env` left in a directory. That is why
 * this needs no precedence code of its own.
 *
 * Called from `isMain()` below and NOWHERE else, on two counts:
 *   - `runCli(argv, env)` takes its environment as a parameter, so a test passes a fake and loading
 *     inside it would mutate the real process to no effect.
 *   - the vitest suite must never pick a `.env` up. `YOKE_TEST_OPENSEARCH_URL` names a cluster whose
 *     indices the suite DELETES in `beforeAll` (docs/BACKENDS.md). One line written and forgotten
 *     should not be able to wipe a database on `npm test`.
 *
 * ceiling: the working directory's `.env`, and that is all. `node --env-file=<path>` already covers
 * pointing somewhere else, so a flag of ours would be a second way to say the same thing.
 */
export function loadDotEnv(file = ".env"): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}

// Run only when executed directly (not when imported by a test).
// realpathSync: via the npm bin symlink (node_modules/.bin/yoke), argv[1] is the symlink while
// import.meta.url is the real path — a mismatch would make the CLI a silent no-op. This avoids that deployment trap.
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
if (isMain()) {
  // Before runCli, so `env = process.env` already carries the file's values.
  loadDotEnv();
  runCli(process.argv.slice(2)).then((code) => {
    // `process.exitCode`, never `process.exit()`. When stdout is a PIPE node buffers writes and
    // flushes them asynchronously; `process.exit()` tears the process down and discards whatever is
    // still in that buffer. Measured on a 518-record corpus: `yoke list --json > file` wrote 444,706
    // bytes of valid JSON, and the same command through `| jq` received exactly 65,536 — one pipe
    // buffer — with exit 0 and no error. Every scripted reader of `--json`, and every agent shelling
    // out to one, silently got a prefix of the corpus and no way to know. A redirect to a file is
    // synchronous, which is why this hid.
    //
    // Setting the code lets node exit on its own once the streams have drained, so the exit status is
    // unchanged and the output is complete.
    process.exitCode = code;
  });
}
