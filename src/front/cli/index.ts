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
import { BRIEFING_LIMIT, inject, WALK_BUDGET } from "../../core/inject.js";
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
  parsePersonaSources,
  personaQuery,
  renderPersonaSkill,
  safeName,
} from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { injectDetail, injectShape, summarize } from "../display.js";
import { runMcp } from "../mcp/index.js";
import { runServe } from "../serve/index.js";
import { type AuditEvent, openStore, type YokeStore } from "../store.js";
import { runUi } from "../ui/server.js";
import { banner, decorated, getStartedBlock, log } from "./banner.js";

type Values = {
  db?: string;
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

/** Compact grouped usage — one source for --help, no-args, and unknown-command. */
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
      const { entity, duplicates, duplicateDetection } = await commit(
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
          "no duplicate check ran: no embedding provider configured. " +
            "Set YOKE_EMBED_URL and YOKE_EMBED_MODEL (see README), then: yoke backfill --embeddings",
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
// endpoints and `add` has nowhere to put them, so it fails with "relation requires non-empty from".
// That left `relates_to` reachable only through `add --scope`, and `works_on`/`supersedes` reachable
// not at all — a collaboration whose roster could never be recorded. Reads as a sentence on purpose:
// `yoke link <person> works_on <collaboration>`.
async function cmdLink(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [from, type, to] = positionals;
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
      const { entity } = await commit(
        store,
        ontology,
        { type, attributes, from, to },
        { actor, origin: "cli", occurred_at: ts },
        ts,
        { ns },
      );
      emit(v, formatEntity(entity), entity);
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
    console.error("usage: yoke get <id> [--version n] [--relations]");
    return 1;
  }
  const version = v.version === undefined ? undefined : Number(v.version);
  const actor = resolveActor(v, env);
  const getNs = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const e = await store.getEntity(id, version);
    if (!e) {
      console.error(`not found: ${id}`);
      return 1;
    }
    // A read of full attributes, which is where SPEC draws the audit line — and the twin of
    // `GET /api/entity/:id`. The rule is per front ADAPTER: if only the browser wrote this row,
    // "who read this record" would be unanswerable for every read done the normal way, which is
    // exactly how `verify` drifted before v5.0.
    store.logAudit({
      actor,
      action: "read",
      detail: e.id,
      at: now(),
      ns: getNs,
    });
    if (!v.relations) {
      emit(v, formatEntity(e), e);
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
      [
        formatEntity(e),
        lines.length ? lines.join("\n") : "  (no relations)",
      ].join("\n"),
      { ...e, relations: edges },
    );
    return 0;
  });
}

// list / graph — the CLI half of the browse and graph screens. WEB-UI's rule is that every action
// the web tier performs stays achievable here, so these exist for parity, and --json emits the same
// shape the endpoints do (byte-for-byte, so parity is checkable and not just claimed).
async function cmdList(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = store.loadOntology(ns);
    const p = await store.listEntities({
      ns,
      type: v.type,
      status: v.status,
      after: v.after,
      limit: v.limit === undefined ? undefined : Number(v.limit),
    });
    if (p.items.length === 0) {
      emit(v, "nothing to list", p);
      return 0;
    }
    const lines = p.items.map(
      (e) =>
        `${e.id}  ${e.type}  ${e.status}  ${summarize(e, ontology)}  ${e.provenance.actor}`,
    );
    if (p.next) lines.push(`-- more: yoke list --after ${p.next}`);
    emit(v, lines.join("\n"), p);
    return 0;
  });
}

async function cmdGraph(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  const limit = v.limit === undefined ? 300 : Number(v.limit);
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

async function cmdSearch(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0];
  if (!query) {
    console.error(
      "usage: yoke search <query> [--type t] [--status s] [--limit n]",
    );
    return 1;
  }
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  const actor = resolveActor(v, env);
  return withStore(v, env, async (store) => {
    const results = await store.search({
      text: query,
      type: v.type,
      // `--status` exists so this command and `/api/search` can express the same query. Without it
      // the browser could ask a question the CLI could not, which is the parity rule broken.
      status: v.status,
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
    emit(v, results.map(formatEntity).join("\n"), results);
    return 0;
  });
}

async function cmdReview(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  const limit = v.limit === undefined ? undefined : Number(v.limit);
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
        { ns, type: v.type, limit, after: v.after },
      );
      if (items.length === 0) {
        emit(v, `no stale records (scanned ${scanned} verified)`, []);
        return 0;
      }
      const lines = items.map(
        (e) =>
          `${e.id}  ${e.type}  ${summarize(e, ontology)}  ${e.provenance.actor}  last confirmed ${e.last_confirmed}`,
      );
      // The scan is bounded, so say what it covered — "3 stale" alone reads as "3 stale in the whole
      // corpus", which is a claim this walk did not make.
      lines.push(
        `-- ${items.length} stale among ${scanned} verified records scanned` +
          (next === null ? "" : `; more to scan: --after ${next}`),
      );
      emit(v, lines.join("\n"), items);
      return 0;
    }
    const drafts = (
      await store.listEntities({ status: "draft", ns, type: v.type })
    ).items;
    if (drafts.length === 0) {
      emit(v, "no drafts", []);
      return 0;
    }
    const lines = drafts.map(
      (e) =>
        `${e.id}  ${e.type}  ${summarize(e, ontology)}  ${e.provenance.actor}  ${e.provenance.occurred_at}`,
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
    const promoted = await verify(store, ids, actor, ts);
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
    console.error("usage: yoke deprecate <id...> [--actor a]");
    return 1;
  }
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    const done = await deprecate(store, positionals, actor, ts);
    // Retiring knowledge changes what every future injection returns, so it belongs in the trail
    // for the same reason verify does.
    store.logAudit({
      actor,
      action: "deprecate",
      detail: done.map((e) => e.id).join(" "),
      at: ts,
      ns,
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

async function cmdInject(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const query = positionals[0] ?? "";
  // `--scope <id>` with no query is a briefing of that working context — the MCP tool and the web
  // route have always allowed it, and the CLI's require-a-query guard silently made the one front
  // adapter a human uses unable to reproduce what an agent receives (the CLI-achievable rule).
  if (!query && v.scope === undefined) {
    console.error(
      "usage: yoke inject <query> [--include-draft] [--limit n] [--scope id] [--as-of ts]\n" +
        "       yoke inject --scope <id>            briefing of that working context\n" +
        "       yoke inject --scope <id> --depth 2  and what that context's context knows\n" +
        "       yoke inject <query> --as-of <ts>    what this would have injected then",
    );
    return 1;
  }
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const ontology = requireOntology(store, ns, v, env);
    if (!ontology) return 1;
    const ts = now();
    // Same default as the MCP tool and the web route: an anchored briefing is capped, a query is not.
    // Without it, `yoke inject --scope <collaboration>` dumps every record ever attached to that work.
    const briefing = v.scope !== undefined && !query;
    const { items, omitted, walk } = await inject(store, ontology, query, ts, {
      includeDraft: v["include-draft"],
      limit: limit ?? (briefing ? BRIEFING_LIMIT : undefined),
      ns,
      // The MCP tool has always passed a scope; the CLI never did, so the two front ends could not
      // reproduce each other's results (WEB-UI's CLI-achievable rule).
      scope: v.scope,
      // Relation hops the anchor walk takes (SPEC "Multi-hop"). 1 = the v4.0 behaviour.
      depth: v.depth === undefined ? undefined : Number(v.depth),
      asOf: v["as-of"],
      // Hybrid retrieval (SPEC "Hybrid retrieval"): the same env-configured embedder the gate uses,
      // so `yoke inject` and `yoke_inject` cannot retrieve differently for the same query.
      embedder: makeFetchEmbedder(env),
    });
    // Injection audit (PLAN 8.4): who got what knowledge injected. Logged at the front tier — core stays pure.
    store.logAudit({
      actor: resolveActor(v, env),
      action: "inject",
      detail: injectDetail(
        items.map((it) => it.entity.id),
        { query, scope: v.scope, asOf: v["as-of"] },
      ),
      at: ts,
      ns,
    });
    const lines = items.map(
      (it) => `${it.citation}  ${summarize(it.entity, ontology)}`,
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
    const ontology = store.loadOntology(resolveNs(v.ns, env));
    // Core's helper, not `store.listHistory` — that extension is synchronous and therefore absent on a
    // remote backend (SPEC "Remote backends"). `listVersions` feature-detects it and otherwise walks
    // `getEntity(id, version)`, so this command works on every backend.
    const versions = await listVersions(store, id);
    if (versions.length === 0) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const lines = versions.map(
      (e) =>
        `v${e.version}  ${e.status}  ${e.provenance.actor}  ${e.last_confirmed}  ${summarize(e, ontology)}`,
    );
    emit(v, lines.join("\n"), versions);
    return 0;
  });
}

async function cmdAudit(v: Values, env: Env): Promise<number> {
  const ns = resolveNs(v.ns, env);
  return withStore(v, env, async (store) => {
    const events = store.listAudit({
      since: v.since,
      ns,
      limit: v.limit === undefined ? undefined : Number(v.limit),
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
    const top = v.limit === undefined ? undefined : Number(v.limit);
    const o = await overview(store, ontology, now(), { ns, top });
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
  const limit = v.limit === undefined ? undefined : Number(v.limit);
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
      await store.saveOntology([def], ns);
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
    if (!person) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const ts = now();
    const result = await personaQuery(store, ontology, id, ts, { ns });
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
  const port = v.port === undefined ? 4800 : Number(v.port);
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
  const port = v.port === undefined ? 4800 : Number(v.port);
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
      case "link":
        return await cmdLink(rest, values, env);
      case "add":
        return await cmdAdd(rest, values, env);
      case "get":
        return await cmdGet(rest, values, env);
      case "list":
        return await cmdList(values, env);
      case "graph":
        return await cmdGraph(values, env);
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
        console.error(`unknown command: ${command}\n\n${usage()}`);
        return 1;
    }
  } catch (e) {
    console.error((e as Error).message);
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
 *   - the vitest suite must never pick a `.env` up. `YOKE_TEST_NEO4J_URL` names a database the neo4j
 *     suite ERASES, and it has erased a real corpus once (docs/BACKENDS.md). One line written and
 *     forgotten should not be able to wipe a database on `npm test`.
 *
 * ponytail: the working directory's `.env`, and that is all. `node --env-file=<path>` already covers
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
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
