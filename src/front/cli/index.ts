#!/usr/bin/env node

// yoke CLI skeleton (PLAN 1.7) — uses only node:util parseArgs (no commander etc.).
// Command handlers are split out as runCli(argv, env) — testable without spawning a process; exit code is the return value.
// Time is obtained only in this front tier (core receives `now` by injection).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
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
import { runUi } from "../ui/server.js";

type Values = {
  db?: string;
  actor?: string;
  ns?: string;
  port?: string;
  attr?: string[];
  version?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  repo?: string;
  since?: string;
  out?: string;
  mapping?: string;
  dsn?: string;
  sqlite?: string;
  channel?: string;
  name?: string;
  scopes?: string;
  auth?: boolean;
  "all-drafts"?: boolean;
  "include-draft"?: boolean;
};

const OPTIONS = {
  db: { type: "string" },
  actor: { type: "string" },
  ns: { type: "string" },
  port: { type: "string" },
  attr: { type: "string", multiple: true },
  version: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  json: { type: "boolean" },
  repo: { type: "string" },
  since: { type: "string" },
  out: { type: "string" },
  mapping: { type: "string" },
  dsn: { type: "string" },
  sqlite: { type: "string" },
  channel: { type: "string" },
  name: { type: "string" },
  scopes: { type: "string" },
  auth: { type: "boolean" },
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
  for (const val of Object.values(attributes)) {
    if (typeof val === "string") return val.slice(0, 60);
  }
  return "";
}

async function withStore<T>(
  path: string,
  fn: (s: SqliteStorage) => Promise<T>,
): Promise<T> {
  const store = new SqliteStorage(path);
  await store.init();
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

async function cmdInit(v: Values, env: Env): Promise<number> {
  const db = resolveDb(v, env);
  return withStore(db, async (store) => {
    // Idempotent re-run: if yoke:system already exists, do not re-seed.
    if (await store.getEntity("yoke:system")) {
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
    emit(v, `initialized: ${db}`, { db, seeded: true });
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
    console.error("usage: yoke add <type> [--actor id] [--attr k=v ...]");
    return 1;
  }
  const db = resolveDb(v, env);
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  const attributes = parseAttrs(v.attr ?? []);
  return withStore(db, async (store) => {
    const ontology = store.loadOntology(ns);
    const ts = now();
    try {
      const { entity, duplicates } = await commit(
        store,
        ontology,
        { type, attributes },
        { actor, origin: "cli", occurred_at: ts },
        ts,
        { embedder: makeFetchEmbedder(env), ns },
      );
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
  const db = resolveDb(v, env);
  const version = v.version === undefined ? undefined : Number(v.version);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const actor = resolveActor(v, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const limit = v.limit === undefined ? undefined : Number(v.limit);
  const ns = resolveNs(v.ns, env);
  return withStore(db, async (store) => {
    const ontology = store.loadOntology(ns);
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
    emit(v, items.length ? lines.join("\n") : "no results", items);
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
  const db = resolveDb(v, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  return withStore(db, async (store) => {
    const events = store.listAudit(v.since);
    const lines = events.map(
      (e) => `${e.at}  ${e.actor}  ${e.action}  ${e.detail}`,
    );
    emit(v, events.length ? lines.join("\n") : "no audit events", events);
    return 0;
  });
}

async function cmdConflicts(v: Values, env: Env): Promise<number> {
  const db = resolveDb(v, env);
  return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const ns = resolveNs(v.ns, env);
  if (sub === "list") {
    return withStore(db, async (store) => {
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
    return withStore(db, async (store) => {
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
  const db = resolveDb(v, env);
  const actor = resolveActor(v, env);
  return withStore(db, async (store) => {
    const ontology = store.loadOntology();
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

  const db = resolveDb(v, env);
  const connector = makeRdbMappingConnector({ query, mapping });
  try {
    return await withStore(db, async (store) => {
      const ontology = store.loadOntology();
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
  const db = resolveDb(v, env);
  const ns = resolveNs(v.ns, env);
  return withStore(db, async (store) => {
    const person = await store.getEntity(id);
    if (!person) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const ontology = store.loadOntology(ns);
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
  const db = resolveDb(v, env);
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
    return withStore(db, async (store) => {
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
    return withStore(db, async (store) => {
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
    return withStore(db, async (store) => {
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
      case "mcp":
        // Start the stdio server — does not resolve until the connection closes (keeps the process alive).
        await runMcp(resolveDb(values, env), env);
        return 0;
      default:
        console.error(
          `unknown command: ${command ?? "(none)"}\nusage: yoke <init|add|get|search|review|verify|deprecate|inject|history|audit|conflicts|ontology|connect|persona|ui|serve|token|mcp> ...`,
        );
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
