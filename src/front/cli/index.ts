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
import { CommitRejected, commit } from "../../core/commit.js";
import { makeFetchEmbedder } from "../../core/embedding.js";
import { inject } from "../../core/inject.js";
import { deprecate, verify } from "../../core/lifecycle.js";
import { resolveNs } from "../../core/namespace.js";
import { seedOntology, type TypeDef } from "../../core/ontology.js";
import {
  personaQuery,
  renderPersonaSkill,
  safeName,
} from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { runMcp } from "../mcp/index.js";
import { runServe } from "../serve/index.js";
import { openStore, type YokeStore } from "../store.js";
import { runUi } from "../ui/server.js";
import { banner, decorated, getStartedBlock, log } from "./banner.js";

type Values = {
  db?: string;
  shards?: string;
  actor?: string;
  ns?: string;
  port?: string;
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
};

const OPTIONS = {
  db: { type: "string" },
  shards: { type: "string" },
  actor: { type: "string" },
  ns: { type: "string" },
  port: { type: "string" },
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
  force: { type: "boolean" },
  "replica-of": { type: "string" },
  "refresh-sec": { type: "string" },
  "all-drafts": { type: "boolean" },
  "include-draft": { type: "boolean" },
} as const;

type Env = Record<string, string | undefined>;

const now = (): string => new Date().toISOString();

const resolveDb = (v: Values, env: Env): string =>
  v.db ?? env.YOKE_DB ?? "./yoke.db";

const resolveActor = (v: Values, env: Env): string =>
  v.actor ?? env.YOKE_ACTOR ?? "yoke:system";

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

function formatEntity(e: Entity | Relation): string {
  return `${e.id}  ${e.type}  ${e.status}  v${e.version}  ${JSON.stringify(e.attributes)}`;
}

/** The first string value in attributes, truncated to 60 chars (for compact review/inject output). */
function summarize(attributes: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(attributes)) {
    // external_id is an idempotency key, not content — connector-ingested rows
    // put it first, which made every summary read "rdb:table:1" instead of the
    // actual knowledge. Same for author (metadata, not the statement).
    if (key === "external_id" || key === "author") continue;
    if (typeof val === "string") return val.slice(0, 60);
  }
  return "";
}

/** --shards <file> (or YOKE_SHARDS) if set, else undefined — the single-sqlite fast path. */
const resolveShards = (v: Values, env: Env): string | undefined =>
  v.shards ?? env.YOKE_SHARDS;

/** Compact grouped usage — one source for --help, no-args, and unknown-command. */
function usage(): string {
  return `yoke — knowledge your AI can trust

getting started:
  init                      create ./yoke.db and seed the ontology
  add <type> --attr k=v     stage knowledge (enters as draft)
  review / verify <id...>   inspect and promote drafts
  inject <query>            retrieve verified knowledge with citations

knowledge:  get, search, history, conflicts, deprecate, ontology, persona
capture:    connect github-pr|slack|notes|rdb
serving:    mcp, ui, serve, token
data:       backup, restore, export, audit

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
      `not initialized: ${resolveDb(v, env)} — run 'yoke init' first`,
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

// Ollama auto-detect (TTY init only): a reachable local Ollama with no embedder
// configured means duplicate/contradiction detection is silently off. Suggest the
// two env vars that enable it. Never blocks (300ms timeout) and never fails init.
async function suggestOllamaIfIdle(env: Env): Promise<void> {
  if (env.YOKE_EMBED_URL) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 300);
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: ac.signal,
    });
    if (res.ok) {
      console.log(
        log.warn(
          "embedding provider not configured — Ollama detected; export " +
            "YOKE_EMBED_URL=http://localhost:11434/v1 YOKE_EMBED_MODEL=nomic-embed-text " +
            "to enable duplicate/contradiction detection",
        ),
      );
    }
  } catch {
    // unreachable / timed out — stay silent
  } finally {
    clearTimeout(timer);
  }
}

async function cmdInit(v: Values, env: Env): Promise<number> {
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
      emit(v, `already initialized: ${db}`, { db, seeded: false });
      return 0;
    }
    const ontology = seedOntology();
    store.saveOntology(ontology);
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
      emit(v, `initialized: ${db}`, { db, seeded: true });
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
      const { entity, duplicates } = await commit(
        store,
        ontology,
        { type, attributes },
        prov,
        ts,
        { embedder: makeFetchEmbedder(env), ns },
      );
      // Capture-side linking (v4.0): --scope <entity-id> links the new knowledge to that entity via
      // relates_to, through the same gate (a second commit at the front tier — core commit untouched).
      if (v.scope) {
        await commit(
          store,
          ontology,
          { type: "relates_to", attributes: {}, from: entity.id, to: v.scope },
          prov,
          ts,
          { ns },
        );
      }
      const human =
        duplicates.length > 0
          ? `${formatEntity(entity)}\nsimilar knowledge (${duplicates.length}): ${duplicates.map((d) => d.id).join(" ")}`
          : formatEntity(entity);
      // --json emits the entity as-is (preserving the existing contract). The similar-knowledge warning is human text only.
      emit(v, human, entity);
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

async function cmdGet(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const id = positionals[0];
  if (!id) {
    console.error("usage: yoke get <id> [--version n]");
    return 1;
  }
  const version = v.version === undefined ? undefined : Number(v.version);
  return withStore(v, env, async (store) => {
    const e = await store.getEntity(id, version);
    if (!e) {
      console.error(`not found: ${id}`);
      return 1;
    }
    emit(v, formatEntity(e), e);
    return 0;
  });
}

async function cmdSearch(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0];
  if (!query) {
    console.error("usage: yoke search <query> [--type t] [--limit n]");
    return 1;
  }
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const results = await store.search({
      text: query,
      type: v.type,
      limit,
      ns,
    });
    emit(v, results.map(formatEntity).join("\n"), results);
    return 0;
  });
}

async function cmdReview(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const drafts = store
      .listByStatus("draft", ns)
      .filter((e) => v.type === undefined || e.type === v.type);
    if (drafts.length === 0) {
      emit(v, "no drafts", []);
      return 0;
    }
    const lines = drafts.map(
      (e) =>
        `${e.id}  ${e.type}  ${summarize(e.attributes)}  ${e.provenance.actor}  ${e.provenance.occurred_at}`,
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
      ? store.listByStatus("draft", ns).map((e) => e.id)
      : positionals;
    if (ids.length === 0) {
      console.error("usage: yoke verify <id...> [--all-drafts] [--actor a]");
      return 1;
    }
    const promoted = await verify(store, ids, actor, now());
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
    console.error("usage: yoke deprecate <id...> [--actor a]");
    return 1;
  }
  const actor = resolveActor(v, env);
  return withStore(v, env, async (store) => {
    const done = await deprecate(store, positionals, actor, now());
    emit(
      v,
      `deprecated ${done.length}: ${done.map((e) => e.id).join(" ")}`,
      done,
    );
    return 0;
  });
}

async function cmdInject(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0];
  if (!query) {
    console.error("usage: yoke inject <query> [--include-draft] [--limit n]");
    return 1;
  }
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    const { items } = await inject(store, ontology, query, ts, {
      includeDraft: v["include-draft"],
      limit,
      ns,
    });
    // Injection audit (PLAN 8.4): who got what knowledge injected. Logged at the front tier — core stays pure.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "inject",
      detail: `${query} -> ${items.map((it) => it.entity.id).join(" ")}`,
      at: ts,
    });
    const lines = items.map(
      (it) => `${it.citation}  ${summarize(it.entity.attributes)}`,
    );
    // Draft-invisibility fix: zero verified hits, but drafts match → say so, don't imply the
    // knowledge simply isn't there. --json output stays the raw items array (contract unchanged).
    let human = items.length ? lines.join("\n") : "no results";
    if (items.length === 0 && !v.json) {
      const drafts = await store.search({ text: query, status: "draft", ns });
      if (drafts.length > 0) {
        human = `no verified knowledge (${drafts.length} draft match(es) withheld — review with 'yoke review')`;
      }
    }
    emit(v, human, items);
    return 0;
  });
}

// history (PLAN 8.4): the append-only version rows ARE the change audit — this just exposes them.
async function cmdHistory(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const id = positionals[0];
  if (!id) {
    console.error("usage: yoke history <id>");
    return 1;
  }
  return withStore(v, env, async (store) => {
    const versions = store.listHistory(id);
    if (versions.length === 0) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const lines = versions.map(
      (e) =>
        `v${e.version}  ${e.status}  ${e.provenance.actor}  ${e.last_confirmed}  ${summarize(e.attributes)}`,
    );
    emit(v, lines.join("\n"), versions);
    return 0;
  });
}

async function cmdAudit(v: Values, env: Env): Promise<number> {
  return withStore(v, env, async (store) => {
    const events = store.listAudit(v.since);
    const lines = events.map(
      (e) => `${e.at}  ${e.actor}  ${e.action}  ${e.detail}`,
    );
    emit(v, events.length ? lines.join("\n") : "no audit events", events);
    return 0;
  });
}

async function cmdConflicts(v: Values, env: Env): Promise<number> {
  return withStore(v, env, async (store) => {
    const rels = store.listRelationsByType("conflicts_with");
    if (rels.length === 0) {
      emit(v, "no conflicts", []);
      return 0;
    }
    // Join each pair's two entity summaries onto one line (resolution is via verify/deprecate — no dedicated command).
    const items = await Promise.all(
      rels.map(async (r) => {
        const from = await store.getEntity(r.from);
        const to = await store.getEntity(r.to);
        return { relation: r, from, to };
      }),
    );
    const lines = items.map(({ relation, from, to }) => {
      const side = (e: Entity | null, id: string) =>
        e
          ? `${e.id} [${e.status}] ${summarize(e.attributes)}`
          : `${id} (missing)`;
      return `${relation.id}\n  ${side(from, relation.from)}\n  <-> ${side(to, relation.to)}`;
    });
    emit(v, lines.join("\n"), items);
    return 0;
  });
}

async function cmdOntology(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [sub, file] = positionals;
  const ns = resolveNs(v.ns, env);
  if (sub === "list") {
    return withStore(v, env, async (store) => {
      const defs = store.loadOntology(ns);
      const lines = defs.map(
        (d) => `${d.name}  ${d.kind}  ttl=${d.ttl_days ?? "∞"}`,
      );
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
      store.saveOntology([def], ns);
      emit(v, `saved type: ${def.name}`, def);
      return 0;
    });
  }
  console.error("usage: yoke ontology <list|add-type <json-file>>");
  return 1;
}

/** Shared connect tail: route any connector through ingest (draft staging, idempotent external_id). */
async function runIngest(
  connector: Connector,
  v: Values,
  env: Env,
): Promise<number> {
  const actor = resolveActor(v, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, undefined, v, env);
    if (!ontology) return 1;
    const { added, skipped } = await ingest(
      store,
      ontology,
      connector,
      actor,
      now(),
      v.since,
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
    return await withStore(v, env, async (store) => {
      const ontology = requireOntology(store, undefined, v, env);
      if (!ontology) return 1;
      const { added, updated, skipped } = await ingestMapped(
        store,
        ontology,
        connector,
        now(),
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
  const id = positionals[0];
  if (!id) {
    console.error("usage: yoke persona <person-id> [--out dir]");
    return 1;
  }
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const person = await store.getEntity(id);
    if (!person) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const ts = now();
    const result = await personaQuery(store, ontology, id, ts, ns);
    const md = renderPersonaSkill(person, result, ts);
    // fs lives only in the CLI tier (core produces only a string).
    const outDir = join(v.out ?? ".", `persona-${safeName(id)}`);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, "SKILL.md");
    writeFileSync(file, md);
    const sources = result.decisions.length + result.facts.length;
    emit(v, `saved: ${file}\nsource knowledge: ${sources}`, {
      path: file,
      sources,
    });
    return 0;
  });
}

// ui (PLAN 9.x): the governance workbench. Server keeps the process alive until SIGINT.
async function cmdUi(v: Values, env: Env): Promise<number> {
  const port = v.port === undefined ? 4800 : Number(v.port);
  const server = await runUi(
    resolveDb(v, env),
    port,
    env,
    resolveNs(v.ns, env),
    resolveShards(v, env),
  );
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}

// serve (PLAN-V2 10.2): UI + JSON API + remote MCP on one port. Auth (10.3/10.4) is opt-in.
async function cmdServe(v: Values, env: Env): Promise<number> {
  const port = v.port === undefined ? 4800 : Number(v.port);
  const server = await runServe(resolveDb(v, env), port, env, {
    auth: v.auth,
    ns: resolveNs(v.ns, env),
    replicaOf: v["replica-of"],
    refreshSec:
      v["refresh-sec"] === undefined ? undefined : Number(v["refresh-sec"]),
    shards: resolveShards(v, env),
  });
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}

// token (PLAN-V2 10.3): API tokens for serve-mode Bearer auth. Secret is shown once on create.
async function cmdToken(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [sub] = positionals;
  if (sub === "create") {
    if (!v.name || !v.scopes) {
      console.error(
        'usage: yoke token create --name <n> --scopes "read,write[,ns:type:verify...]"',
      );
      return 1;
    }
    const scopes = v.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return withStore(v, env, async (store) => {
      const { token } = store.createToken({
        name: v.name as string,
        scopes,
        created_at: now(),
      });
      // The plaintext secret is only ever returned here — store it now (only the hash is persisted).
      emit(v, token, { name: v.name, scopes, token });
      return 0;
    });
  }
  if (sub === "list") {
    return withStore(v, env, async (store) => {
      const toks = store.listTokens();
      const lines = toks.map(
        (t) => `${t.name}  ${t.scopes.join(",")}  ${t.created_at}`,
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
async function cmdBackup(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const dest = positionals[0];
  if (!dest) {
    console.error("usage: yoke backup <dest.db>");
    return 1;
  }
  const db = resolveDb(v, env);
  return withStore(v, env, async (store) => {
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
  return withStore(v, env, async (store) => {
    await store.exportUntil(v.until as string, v.out as string);
    emit(v, `exported state as of ${v.until} -> ${v.out}`, {
      until: v.until,
      out: v.out,
    });
    return 0;
  });
}

export async function runCli(
  argv: string[],
  env: Env = process.env,
): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || command === "help" || command === undefined) {
    console.log(usage());
    return 0;
  }
  try {
    switch (command) {
      case "init":
        return await cmdInit(values, env);
      case "add":
        return await cmdAdd(rest, values, env);
      case "get":
        return await cmdGet(rest, values, env);
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
      case "ontology":
        return await cmdOntology(rest, values, env);
      case "connect":
        return await cmdConnect(rest, values, env);
      case "persona":
        return await cmdPersona(rest, values, env);
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
        console.error(`unknown command: ${command}\n\n${usage()}`);
        return 1;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
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
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
