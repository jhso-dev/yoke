#!/usr/bin/env node

// yoke CLI skeleton — uses only node:util parseArgs (no commander etc.).
// Command handlers are split out as runCli(argv, env) — testable without spawning a process; exit code is the return value.
// Time is obtained only in this front tier (core receives `now` by injection).

import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { makeFetchExtractor, numEnv } from "../../connectors/extract.js";
import { makeGithubPrConnector } from "../../connectors/github-pr.js";
import { makeNotesConnector } from "../../connectors/meeting-notes.js";
import { type ExtractStats, makeRawConnector } from "../../connectors/raw.js";
import {
  ingestMapped,
  type MappingSpec,
  type RdbMappingConnector,
} from "../../connectors/rdb-mapping.js";
import {
  candidates,
  groupsFor,
  makeFetchRelater,
  neighbourCount,
  relateText,
} from "../../connectors/relate.js";
import { makeSlackConnector } from "../../connectors/slack.js";
import type { Connector } from "../../connectors/types.js";
import { commit } from "../../core/commit.js";
import {
  makeFetchEmbedder,
  resolveEmbedConfig,
  suppressEmbedAnnounce,
} from "../../core/embedding.js";
import { resolveNs } from "../../core/namespace.js";
import { seedOntology, type TypeDef } from "../../core/ontology.js";
import { instantFlag, intFlag, noExtra, UsageError } from "../params.js";
import { parseScope, SCOPE_GRAMMAR, validateScopes } from "../serve/rbac.js";
import { openStore, type YokeStore } from "../store.js";
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
  neo4j?: string;
  channel?: string;
  name?: string;
  scope?: string;
  scopes?: string;
  auth?: boolean;
  until?: string;
  force?: boolean;
  "replica-of"?: string;
  relations?: boolean;
  after?: string;
  status?: string;
  "as-of"?: string;
  unseen?: boolean;
  embeddings?: boolean;
  rebuild?: boolean;
  "occurred-at"?: boolean;
  "dry-run"?: boolean;
  shape?: boolean;
  pulse?: boolean;
  roi?: boolean;
  assume?: string[];
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
  neo4j: { type: "string" },
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
  relations: { type: "boolean" },
  after: { type: "string" },
  status: { type: "string" },
  "as-of": { type: "string" },
  unseen: { type: "boolean" },
  embeddings: { type: "boolean" },
  rebuild: { type: "boolean" },
  "occurred-at": { type: "boolean" },
  "dry-run": { type: "boolean" },
  shape: { type: "boolean" },
  pulse: { type: "boolean" },
  roi: { type: "boolean" },
  assume: { type: "string", multiple: true },
  depth: { type: "string" },
  check: { type: "string" },
} as const;

type Env = Record<string, string | undefined>;

const now = (): string => new Date().toISOString();

const resolveDb = (v: Values, env: Env): string =>
  v.db ?? env.YOKE_DB ?? "./yoke.db";

const resolveActor = (v: Values, env: Env): string =>
  v.actor ?? env.YOKE_ACTOR ?? "yoke:system";

/** Machine JSON with --json, human text otherwise. */
function emit(v: Values, human: string, data: unknown): void {
  console.log(v.json ? JSON.stringify(data) : human);
}

/** --shards <file> (or YOKE_SHARDS) if set, else undefined — the single-sqlite fast path. */
const resolveShards = (v: Values, env: Env): string | undefined =>
  v.shards ?? env.YOKE_SHARDS;

/** What the store a command just opened is, for messages and `--json`.
 *
 * `resolveDb` alone names the LOCAL sqlite whatever the store actually is; under `--shards` that is
 * wrong, and under a remote backend it is half true (the local db still holds this client's audit +
 * tokens), so this reports both halves rather than picking one. */
function storeLabel(v: Values, env: Env): string {
  const shards = resolveShards(v, env);
  if (shards) return `shards ${shards}`;
  const db = resolveDb(v, env);
  const remote = env.YOKE_OPENSEARCH_URL ?? env.YOKE_POSTGRES_URL;
  if (remote) return `${remote} (audit + tokens: ${db})`;
  return db;
}

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
  "relate",
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

/** The commands that act on a MACHINE rather than on a corpus: they open a file, bind a port, or
 * sign a credential, and a server is no help with any of it. Everything else is a client call. */
const LOCAL_COMMANDS = new Set([
  "init",
  "serve",
  "ui",
  "mcp",
  "token",
  "backup",
  "restore",
  "export",
]);

function usage(): string {
  return `yoke — knowledge your AI can trust

getting started:
  init                      create ./yoke.db and seed the ontology
  add <type> --attr k=v     record knowledge (live immediately, signed by --actor)
  review                    the re-confirmation queue: what went stale, most-consumed first
  verify <id...>            re-confirm — refresh a record's freshness window (also revives a retired id)
  inject <query>            retrieve standing knowledge with citations (--scope id, --depth n, --unseen)

knowledge:  get, list, graph, search, history, conflicts, deprecate, ontology, persona
  overview                  the shape of the whole corpus: types, hubs, authors (--limit n)
  link <from> <relation> <to>   record a relation (works_on, supersedes, relates_to …)
capture:    connect github-pr|slack|notes|rdb
  connect raw <dir>         a model proposes records from unstructured material (needs YOKE_LLM_*)
  relate                    a model proposes the links BETWEEN stored records (needs YOKE_LLM_*)
serving:    mcp, ui, serve, token   (--port, --host; loopback unless --host is given)
data:       backup, restore, export, audit, backfill, rename-type
  audit --shape             workload composition: anchored / briefing / plain injections
  audit --pulse             collaboration health: capture, interrupts, recall reach, relitigation
  audit --roi               efficiency: minutes saved over minutes spent, assumptions in the open

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
//
// `create` is the opt-out for the two commands that bootstrap a store from nothing — `init` and
// `ontology add-type` (which seeds a fresh tenant ontology). For everything else a read or write on a
// store that was never `yoke init`ed must REFUSE, and must not bring the file into existence doing it:
// `openStore` opens a better-sqlite3 Database, which creates the path, so the guard runs BEFORE it —
// otherwise a read on a typo'd `--db` prints "nothing", exits 0, and leaves a stray db behind. This
// matches the refusal `requireOntology` prints for `add`/`inject`/`overview`. Only the local
// single-file path is judged by file existence; a sharded or remote store initializes elsewhere.
async function withStore<T>(
  v: Values,
  env: Env,
  fn: (s: YokeStore) => Promise<T>,
  opts?: { create?: boolean; writesKnowledge?: boolean },
): Promise<T> {
  const remote = env.YOKE_OPENSEARCH_URL ?? env.YOKE_POSTGRES_URL;
  // `init`, `backup` and `export` act on a store, so a remote one is theirs to open — they are what
  // an operator runs where the corpus lives. `relate` and `connect rdb` are different: they FILE
  // knowledge, and on this path `--actor` is an unverified string. Harmless when the store is one
  // person's file; forged authorship when it is the team's.
  //
  // ceiling: those two still open a store at all because each walks the whole corpus to decide what
  // to file, which belongs behind the server the way the audit reports do. Until they move, this is
  // the guard. YOKE_SOLO is the single-user-at-scale opt-out (docs/SCALE.md).
  if (opts?.writesKnowledge && remote && !env.YOKE_SOLO)
    throw new UsageError(
      `${env.YOKE_OPENSEARCH_URL ? "YOKE_OPENSEARCH_URL" : "YOKE_POSTGRES_URL"} points this command ` +
        "straight at a shared knowledge store, where nothing verifies who you say you are. Run it " +
        "where the server runs, or set YOKE_SOLO=1 if this store is yours alone.",
    );
  if (
    !opts?.create &&
    !resolveShards(v, env) &&
    !remote &&
    !existsSync(resolveDb(v, env))
  )
    throw new UsageError(
      `not initialized: ${storeLabel(v, env)} — run 'yoke init' first`,
    );
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
 * stack"). An English-centric model (e.g. `nomic-embed-text`) makes the vector half of retrieval
 * useless on a corpus with substantial non-English knowledge — indistinguishable from no embedder. */
const SUGGESTED_EMBED_MODEL = "bge-m3";

// What `init` says about embeddings: the state of retrieval on this machine, resolved by the SAME
// function every later command embeds through (core `resolveEmbedConfig`) so the two cannot disagree
// about whether an embedder exists. Never blocks (the resolver is bounded) and never fails init.
async function reportEmbedderAtInit(env: Env): Promise<void> {
  const cfg = await resolveEmbedConfig(env);
  // Pinned by env: the operator already knows, and repeating their own configuration is noise.
  if (cfg && !cfg.auto) return;
  // Silence the one-shot runtime notice: init has just said the same thing, more fully.
  suppressEmbedAnnounce();
  console.log(
    cfg
      ? log.ok(
          `embeddings on — using ${cfg.model} at ${cfg.url} (no configuration needed; ` +
            "set YOKE_EMBED_URL/MODEL to pin a different provider)",
        )
      : log.warn(
          "no embedding provider — retrieval will be keyword-only and duplicate/contradiction " +
            `detection is skipped. Run 'ollama pull ${SUGGESTED_EMBED_MODEL}' (it is then used ` +
            "automatically), or set YOKE_EMBED_URL and YOKE_EMBED_MODEL",
        ),
  );
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
  return withStore(
    v,
    env,
    async (store) => {
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
        await reportEmbedderAtInit(env);
      } else {
        emit(v, `initialized: ${store_}`, { db, store: store_, seeded: true });
      }
      return 0;
      // `init` is one of the two commands that legitimately bring a fresh db into existence.
    },
    { create: true },
  );
}

const GET_USAGE = "usage: yoke get <id> [--version n] [--relations]";

// list / graph — the CLI half of the browse and graph screens. WEB-UI's rule is that every action
// the web tier performs stays achievable here, so these exist for parity, and --json emits the same
// shape the endpoints do (byte-for-byte, so parity is checkable and not just claimed).
const LIST_USAGE =
  "usage: yoke list [--type t] [--status s] [--limit n] [--after cursor]\n" +
  "  a whole-namespace listing; to search by words use 'yoke search <query>'";

const GRAPH_USAGE =
  "usage: yoke graph [--limit n]\n" +
  "  the whole namespace; for one record's neighbourhood use 'yoke get <id> --relations'";

const SEARCH_USAGE =
  "usage: yoke search <query> [--type t] [--status s] [--limit n]\n" +
  '  quote a phrase: yoke search "retry budget"';

const INJECT_USAGE =
  "usage: yoke inject <query> [--limit n] [--scope id] [--as-of ts] [--since ts]\n" +
  '  quote a phrase: yoke inject "retry budget"\n' +
  "       yoke inject --scope <id>            briefing of that working context\n" +
  "       yoke inject --scope <id> --depth 2  and what that context's context knows\n" +
  "       yoke inject --scope <id> --unseen   only what this client has not been handed yet — silent when nothing\n" +
  "       yoke inject <query> --as-of <ts>    what this would have injected then\n" +
  "       yoke inject <query> --since <ts>    only records whose current version began after then";

// history: the append-only version rows ARE the change audit — this just exposes them.
const HISTORY_USAGE = "usage: yoke history <id>";

// relate — a model proposes the edges between records already in the store (connectors/relate.ts
// says why that is a command of its own). What it files is a claim about two records rather than
// one, signed by the connector's actor like every other automatic path.
async function cmdRelate(v: Values, env: Env): Promise<number> {
  const actor = resolveActor(v, env);
  const ns = resolveNs(v.ns, env);
  const limit = v.limit === undefined ? 500 : Number(v.limit);
  return withStore(
    v,
    env,
    async (store) => {
      const ontology = requireOntology(store, ns, v, env);
      if (!ontology) return 1;
      const relater = makeFetchRelater(env, ontology);
      // The same refusal as `connect raw`: an unconfigured run would report "0 links" and look like a
      // corpus with nothing to connect.
      if (!relater) {
        console.error(
          "relate needs a model: set YOKE_LLM_URL and YOKE_LLM_MODEL (YOKE_LLM_KEY if the endpoint needs auth)",
        );
        return 1;
      }
      const records = await candidates(store, ns, limit);
      if (records.length < 2) {
        emit(v, "nothing to relate: fewer than two records on this scope", []);
        return 0;
      }
      const groups = await groupsFor(
        store,
        records,
        // relateText, NOT summarize: the terminal's 60-character one-liner drops a decision's
        // rationale, which is the half that says a position changed — see relateText.
        (e) => relateText(e, ontology),
        ns,
        neighbourCount(env),
      );
      let added = 0;
      let existed = 0;
      // A call that never answered and a proposal the gate refused are different failures: the first
      // says the endpoint is unreachable, the second says the model answered and was wrong. Counted
      // together, a corpus whose every proposal is a duplicate edge reports an outage.
      let failedCalls = 0;
      let rejected = 0;
      const rejections = new Map<string, number>();
      for (const { refs, byRef } of groups) {
        const proposed = await relater(refs);
        if (proposed === null) {
          failedCalls++;
          continue;
        }
        for (const p of proposed) {
          const from = byRef.get(p.from);
          const to = byRef.get(p.to);
          if (!from || !to) continue;
          const ts = now();
          try {
            const res = await commit(
              store,
              ontology,
              {
                type: p.type,
                // The sentence that justified the edge, kept beside it for the same reason a record
                // keeps its quote: a reviewer deciding whether this link is real should not have to
                // reconstruct why a model thought so.
                attributes: p.because ? { rationale: p.because } : {},
                from: from.id,
                to: to.id,
              },
              { actor, origin: "cli", occurred_at: ts },
              ts,
              { ns },
            );
            res.existed ? existed++ : added++;
          } catch (e) {
            // One bad proposal must not end a batch that also contains good ones — but a bare count
            // of rejections tells nobody what to change. The reason is the whole value of the number:
            // a model naming an undeclared attribute is a prompt to fix, and a gate refusing a
            // duplicate edge is nothing to fix at all.
            rejected++;
            const why = (e as Error).message;
            rejections.set(why, (rejections.get(why) ?? 0) + 1);
          }
        }
      }
      if (failedCalls > 0 && added === 0 && existed === 0 && rejected === 0) {
        console.error(
          `yoke: every relating call failed over ${records.length} records — nothing was linked. Check that YOKE_LLM_URL is reachable.`,
        );
        return 1;
      }
      for (const [why, n] of [...rejections].sort((a, b) => b[1] - a[1]))
        console.error(`yoke: ${n} proposal(s) rejected — ${why}`);
      if (failedCalls > 0)
        console.error(
          `yoke: ${failedCalls} of ${groups.length} relating call(s) never answered — those records were not considered`,
        );
      emit(
        v,
        `linked ${added}, already linked ${existed}, rejected ${rejected}`,
        {
          added,
          existed,
          rejected,
          failedCalls,
          rejections: Object.fromEntries(rejections),
        },
      );
      return 0;
    },
    { writesKnowledge: true },
  );
}

const ONTOLOGY_USAGE = "usage: yoke ontology <list|add-type <json-file>>";

/** Shared connect tail: pull here, commit on the server (the gate, idempotent external_id). */
async function runIngest(
  // A factory, because an extracting connector is built FROM the ontology (the type menu it may
  // propose into), and the ontology belongs to the corpus, not to this machine.
  connector: Connector | ((ontology: TypeDef[]) => Connector),
  v: Values,
  env: Env,
): Promise<number> {
  const { remoteIngest, remoteOntology, resolveRemote } = await import(
    "../remote.js"
  );
  const remote = resolveRemote(env, {
    actor: v.actor ?? env.YOKE_ACTOR,
    ns: resolveNs(v.ns, env) ?? undefined,
  });
  const ontology = await remoteOntology(remote);
  if (ontology.length === 0) {
    console.error("not initialized: run 'yoke init' first");
    return 1;
  }
  const { added, updated, skipped, rejected } = await remoteIngest(
    remote,
    typeof connector === "function" ? connector(ontology) : connector,
    {
      since: instantFlag(v.since, "since"),
      // --scope: the working context this sync feeds. Captured knowledge that is only query-reachable
      // never reaches a briefing, so a merged PR's decision would be absent from the opening page of
      // the work it was merged into. Same flag name and meaning as `yoke add --scope`.
      scope: v.scope,
    },
  );
  // `updated` is its own count: a re-ingest that re-versions a corrected paragraph must be visible,
  // not folded into `skipped`.
  const lines = [
    `added ${added}` +
      (updated > 0 ? `, updated ${updated}` : "") +
      `, skipped ${skipped}`,
  ];
  // Named, and a non-zero exit. Silently counting a refused source item is a failure the other way —
  // "added 24" reads as complete.
  if (rejected)
    lines.push(
      `${rejected.length} could not be recorded:`,
      ...rejected.map((r) => `  ${r}`),
    );
  // Absent rather than empty in --json, for the same reason `withheld` is: a caller can tell "nothing
  // was refused" from "this version does not report refusals".
  emit(v, lines.join("\n"), {
    added,
    updated,
    skipped,
    ...(rejected ? { rejected } : {}),
  });
  return rejected ? 1 : 0;
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
      console.error("usage: yoke connect notes <dir> [--actor a] [--scope id]");
      return 1;
    }
    return runIngest(makeNotesConnector({ dir }), v, env);
  }
  if (source === "raw") {
    const dir = positionals[1];
    if (!dir) {
      console.error(
        "usage: yoke connect raw <dir> [--since ts] [--limit n] (YOKE_LLM_URL/YOKE_LLM_MODEL env required)",
      );
      return 1;
    }
    // Refused rather than run, because the no-op extractor would report "added 0, skipped 0" — a
    // clean pass that read every session and proposed nothing, which is what a working run looks
    // like when there is nothing to find.
    if (!env.YOKE_LLM_URL || !env.YOKE_LLM_MODEL) {
      console.error(
        "connect raw needs an extraction model: set YOKE_LLM_URL and YOKE_LLM_MODEL (YOKE_LLM_KEY if the endpoint needs auth)",
      );
      return 1;
    }
    // The same reasoning as the refusal above, one step later: an endpoint that is configured but
    // unreachable also proposes nothing, and "added 0, skipped 0" with exit 0 reads as a clean run.
    const stats: ExtractStats = { calls: 0, failures: 0 };
    const code = await runIngest(
      (ontology) =>
        makeRawConnector({
          dir,
          extract: makeFetchExtractor(env, ontology),
          limit: v.limit === undefined ? undefined : Number(v.limit),
          chunkChars: numEnv(env, "YOKE_EXTRACT_CHUNK_CHARS"),
          concurrency: numEnv(env, "YOKE_EXTRACT_CONCURRENCY"),
          stats,
        }),
      v,
      env,
    );
    if (code === 0 && stats.calls > 0 && stats.failures === stats.calls) {
      console.error(
        `yoke: all ${stats.calls} extraction calls failed — nothing was read from ${dir}. Check that YOKE_LLM_URL is reachable.`,
      );
      return 1;
    }
    // Said only when something was lost, because a hole is invisible afterwards: the records that
    // WOULD have been filed leave no trace, so a partial ingest and a clean one both end "added N".
    if (stats.failures > 0)
      console.error(
        `yoke: ${stats.failures} of ${stats.calls} extraction calls were never read — those spans filed nothing`,
      );
    return code;
  }
  if (source !== "github-pr" || !v.repo) {
    console.error(
      "usage: yoke connect <github-pr --repo owner/name | slack --channel C123 | notes <dir> | raw <dir> | rdb --mapping f.json> [--since ts] [--actor a] [--scope id]",
    );
    return 1;
  }
  return runIngest(
    makeGithubPrConnector({ repo: v.repo, token: env.GITHUB_TOKEN }),
    v,
    env,
  );
}

// connect rdb: read-map an existing RDB into entities. See rdb-mapping.ts for the
// design exception (bulk bypasses the per-record gate, still validates against the ontology).
async function cmdConnectRdb(v: Values, env: Env): Promise<number> {
  if (!v.mapping) {
    console.error(
      "usage: yoke connect rdb --mapping <file.json> [--dsn postgres://...] [--sqlite <path>] [--neo4j http://user:pass@host:7474/db]",
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
  // --sqlite → local better-sqlite3 file (no server needed for local/demo use);
  // --neo4j → HTTP transactional endpoint via fetch (labels as tables — see rdb-neo4j.ts).
  let query: (sql: string) => Promise<Record<string, unknown>[]>;
  let closeSrc = (): void => {};
  if (v.dsn) {
    const { makePgQuery } = await import("../../connectors/rdb-pg.js");
    query = makePgQuery(v.dsn);
  } else if (v.sqlite) {
    const src = new Database(v.sqlite, { readonly: true });
    query = async (sql) => src.prepare(sql).all() as Record<string, unknown>[];
    closeSrc = () => src.close();
  } else if (v.neo4j) {
    const { makeNeo4jQuery } = await import("../../connectors/rdb-neo4j.js");
    query = makeNeo4jQuery(v.neo4j);
  } else {
    console.error("connect rdb requires --dsn, --sqlite or --neo4j");
    return 1;
  }

  const connector: RdbMappingConnector = { query, mapping };
  try {
    const ns = resolveNs(v.ns, env);
    return await withStore(
      v,
      env,
      async (store) => {
        const ontology = requireOntology(store, ns, v, env);
        if (!ontology) return 1;
        const { added, updated, skipped, errors } = await ingestMapped(
          store,
          ontology,
          connector,
          now(),
          ns,
          makeFetchEmbedder(env),
        );
        // `errors` rides the summary and --json: without it a scheduled sync in which EVERY row failed is
        // indistinguishable from a no-op success. The count and the exit code are the only things a cron
        // job can read.
        emit(
          v,
          `mapped ${added} added, ${updated} updated, ${skipped} skipped` +
            (errors > 0 ? `, ${errors} failed (see the messages above)` : ""),
          { added, updated, skipped, errors },
        );
        return errors > 0 ? 1 : 0;
      },
      { writesKnowledge: true },
    );
  } finally {
    closeSrc();
  }
}

// ui: the governance workbench. Server keeps the process alive until SIGINT.
async function cmdUi(v: Values, env: Env): Promise<number> {
  const port = intFlag(v.port, "port", 0) ?? 4800;
  // Imported here, not at the top. The serve/ui subtree pulls the MCP SDK and jose — 94ms of startup,
  // measured — and two commands out of twenty-nine need it, while every `yoke add` paid it.
  const { runUi } = await import("../ui/server.js");
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

// serve (ENTERPRISE "server mode"): UI + JSON API + remote MCP on one port. Auth (10.3/10.4) is opt-in.
async function cmdServe(v: Values, env: Env): Promise<number> {
  const port = intFlag(v.port, "port", 0) ?? 4800;
  const { runServe } = await import("../serve/index.js");
  const server = await runServe(resolveDb(v, env), port, env, {
    auth: v.auth,
    ns: resolveNs(v.ns, env),
    replicaOf: v["replica-of"],
    shards: resolveShards(v, env),
    host: v.host ?? env.YOKE_HOST,
  });
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => server.close(() => resolve()));
  });
  return 0;
}

// token (ENTERPRISE "auth"): API tokens for serve-mode Bearer auth. Secret is shown once on create.
// A PERSON on a GitHub org does not need this — the exchange mints their token from the identity
// they already have (SPEC "GitHub exchange"). This command is for what the exchange cannot cover:
// machine actors (CI, scheduled connectors), the bootstrap admin credential (the exchange never
// grants admin), and a deployment with no GitHub.
const TOKEN_CREATE_USAGE =
  'usage: yoke token create --name <n> --scopes "<ns>:read,<ns>:write[,<ns>:admin]"\n' +
  `  scope = ${SCOPE_GRAMMAR}\n` +
  "  actions: read, write (commit/re-confirm/retire), admin (credentials, ontology migration)\n" +
  "  an action with NO namespace grants every tenant — name the namespace unless you mean that\n" +
  "  people on a GitHub org need no token: the server exchanges their gh login (YOKE_GITHUB_ORG) —\n" +
  "  this command is for machine actors, the bootstrap admin credential, and a GitHub-less deployment";

async function cmdToken(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const [sub] = positionals;
  if (sub !== "create") {
    console.error(
      "usage: yoke token create --name <who> --scopes <list>\n" +
        "  a credential is signed, not stored, so there is nothing to list and nothing to revoke —\n" +
        "  rotate YOKE_TOKEN_SECRET to invalidate every credential at once",
    );
    return 1;
  }
  if (!v.name || !v.scopes) {
    console.error(TOKEN_CREATE_USAGE);
    return 1;
  }
  const checked = validateScopes(v.scopes.split(","));
  if (!checked.ok) {
    console.error(`${checked.error}\n${TOKEN_CREATE_USAGE}`);
    return 1;
  }
  const scopes = checked.scopes;
  // The same key the server verifies with. Without it this would mint something nothing accepts, so
  // it is a refusal rather than a default — see front/serve/credential.ts.
  const { credentialSigner } = await import("../serve/credential.js");
  const signer = credentialSigner(env.YOKE_TOKEN_SECRET);
  if (!signer) {
    console.error(
      "set YOKE_TOKEN_SECRET to the same value the server runs with — a credential is signed with " +
        "it, and a server that does not share the key will refuse what this mints",
    );
    return 1;
  }
  const { token, refresh } = await signer.mint({
    name: v.name as string,
    scopes,
    ns: resolveNs(v.ns, env),
  });
  // A wildcard-ns scope is called out, because `read` reads EVERY tenant and both the usage string
  // and `serve`'s own refusal teach exactly that spelling.
  const wildcard = scopes.filter((raw) => parseScope(raw)?.ns === null);
  emit(
    v,
    [
      token,
      `  name: ${v.name}   scopes: ${scopes.join(", ")}   expires in 7 days`,
      `  refresh (POST /api/refresh, good for a year): ${refresh}`,
      ...(wildcard.length > 0
        ? [
            `  note: ${wildcard.join(", ")} ${wildcard.length === 1 ? "has" : "have"} no namespace, ` +
              `so ${wildcard.length === 1 ? "it grants" : "they grant"} every tenant — ` +
              `write '<namespace>:${parseScope(wildcard[0])?.action}' to scope it to one`,
          ]
        : []),
    ].join("\n"),
    { name: v.name, scopes, token, refresh },
  );
  return 0;
}

// backup (ENTERPRISE "backup"): online WAL-safe snapshot to a fresh file.
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
  // The same guard `restore` has, for the same destruction: overwriting an existing destination is
  // unconfirmed and unrecoverable, so it is refused without `--force`. Named with the destination and
  // the flag, because the ordinary case is a typo'd path rather than a change of mind.
  if (existsSync(dest) && !v.force) {
    console.error(
      `refusing to overwrite existing file: ${dest} (use --force to replace it)`,
    );
    return 1;
  }
  return withStore(v, env, async (store) => {
    // A backup of a damaged database is not a backup: a copy of corruption passes `restore`'s
    // validation and tells the operator they are safe. Refuse to back up a file that fails
    // integrity_check.
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

// restore (ENTERPRISE "backup"): safety-checked copy of a backup back over the working DB. Refuses to clobber
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
      // damaged file those pages are usually intact — so without this a corrupt backup passes
      // validation, is copied over a healthy database, and reports success.
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

// export (ENTERPRISE "backup" PITR-lite): reconstruct DB state as of --until into a new file. See
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

/**
 * `yoke <command> --help`. Five commands take no required argument, so the "run it with missing
 * arguments" convention never fires for them and their flags need documenting somewhere a reader looks.
 *
 * Anything absent here falls back to the top-level usage, which is a worse answer than a specific one and
 * a much better one than executing the command.
 */
const COMMAND_USAGE: Record<string, string> = {
  get: GET_USAGE,
  list: LIST_USAGE,
  graph: GRAPH_USAGE,
  search: SEARCH_USAGE,
  inject: INJECT_USAGE,
  history: HISTORY_USAGE,
  ontology: ONTOLOGY_USAGE,
  backup: BACKUP_USAGE,
  review:
    "usage: yoke review [--type t] [--limit n] [--after cursor]\n" +
    "  the re-confirmation queue: verified records past their type's TTL, most-injected first",
  audit:
    "usage: yoke audit [--since ts] [--until ts] [--limit n] [--shape|--pulse|--roi]\n" +
    "  --shape    workload composition: anchored / briefing / plain injections\n" +
    "  --pulse    collaboration health: capture density, delivery interrupts, recall reach,\n" +
    "             relitigation (--scope adds briefing composition; --since bounds capture)",
  overview: "usage: yoke overview [--limit n]",
  conflicts: "usage: yoke conflicts",
  backfill:
    "usage: yoke backfill [--embeddings] [--rebuild] [--limit n] [--after cursor]\n" +
    "  no flags       re-derive missing authorship edges\n" +
    "  --embeddings   embed records that have no vector\n" +
    "  --rebuild      re-embed records that already have one",
  verify: "usage: yoke verify <id...> [--actor a]",
  deprecate:
    'usage: yoke deprecate <id...> [--actor a] [--reason "why it was retired"]',
  add: "usage: yoke add <type> [--actor id] [--attr k=v ...] [--scope entity-id]",
  link: "usage: yoke link <from-id> <relation> <to-id> [--actor id] [--attr k=v ...]",
  persona:
    "usage: yoke persona <person-id> [--out dir]\n       yoke persona --check <SKILL.md>",
  restore: "usage: yoke restore <src.db> [--force]",
  export: "usage: yoke export --until <iso-ts> --out <new.db>",
  "rename-type": "usage: yoke rename-type <from> <to>",
  token: "usage: yoke token <create|list|revoke> ...",
};

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
  // `--help` with no command is the overview; WITH a command it is that command's usage. For a command
  // with no required arguments the "run it with missing args" convention never fires, so `--type` and
  // `--status` would be documented nowhere a reader would look.
  if (command === "help" || command === undefined) {
    console.log(usage());
    return 0;
  }
  // `--help` never reaches a command: for a command with no required arguments the convention that
  // saves it ("run it with missing arguments to see its usage") does not fire, so without this
  // `<cmd> --help` would EXECUTE the command — and `backfill` writes. Those five commands are also
  // why the table below exists: their flags (`review --type`, `audit --since`, `overview --limit`,
  // `backfill --embeddings`) are documented at no point the convention reaches.
  if (values.help) {
    console.log(COMMAND_USAGE[command] ?? usage());
    return 0;
  }
  try {
    // The CLI judges its own arguments before anything leaves the machine. An extra positional a
    // command silently drops, or a `--limit 0x10` that reaches SQL as 16, is not the server's
    // mistake to catch — and a refusal that costs a round trip is a refusal that can time out.
    switch (command) {
      case "add":
        noExtra(
          rest,
          1,
          "usage: yoke add <type> [--actor id] [--attr k=v ...] [--scope entity-id]\n" +
            "  values go in --attr, not after the type",
        );
        break;
      case "link":
        noExtra(
          rest,
          3,
          "usage: yoke link <from-id> <relation> <to-id> [--actor id] [--attr k=v ...]",
        );
        break;
      case "get":
        noExtra(rest, 1, GET_USAGE);
        intFlag(values.version, "version");
        break;
      case "list":
        if (rest.length > 0)
          throw new UsageError(`list takes no arguments\n${LIST_USAGE}`);
        intFlag(values.limit, "limit");
        break;
      case "graph":
        intFlag(values.limit, "limit");
        intFlag(values.depth, "depth");
        break;
      case "search":
        noExtra(rest, 1, SEARCH_USAGE);
        intFlag(values.limit, "limit");
        break;
      case "review":
      case "persona":
      case "overview":
        intFlag(values.limit, "limit");
        break;
      case "inject":
        noExtra(rest, 1, INJECT_USAGE);
        instantFlag(values["as-of"], "as-of");
        instantFlag(values.since, "since");
        intFlag(values.limit, "limit");
        intFlag(values.depth, "depth");
        break;
      case "history":
        noExtra(rest, 1, HISTORY_USAGE);
        break;
      case "audit":
        instantFlag(values.since, "since");
        instantFlag(values.until, "until");
        intFlag(values.limit, "limit");
        break;
      case "rename-type":
        noExtra(rest, 2, "usage: yoke rename-type <from> <to>");
        break;
      case "ontology":
        noExtra(rest, rest[0] === "list" ? 1 : 2, ONTOLOGY_USAGE);
        break;
      case "connect":
      case "relate":
        instantFlag(values.since, "since");
        break;
    }
    // Everything that touches the corpus goes to a server. Locally that is a `yoke serve` on
    // loopback, ungated and asking for nothing; for a team it is theirs, and the actor is read off
    // the verified credential so `--actor` cannot claim to be somebody. `runRemote` returns null for
    // the commands that act on a MACHINE rather than on a corpus — init, serve, ui, mcp, token and
    // the file commands — and those, and only those, fall through to the switch.
    {
      const { resolveRemote, runRemote } = await import("../remote.js");
      const code = await runRemote(
        // Who this caller says they are. An ungated server takes it (invariant 4: `--actor` has to
        // mean something on a single-user store); a gated one ignores it and reads the credential.
        resolveRemote(env, {
          actor: values.actor ?? env.YOKE_ACTOR,
          ns: resolveNs(values.ns, env) ?? undefined,
        }),
        command,
        rest,
        values,
      );
      if (code !== null) return code;
    }
    switch (command) {
      case "init":
        return await cmdInit(values, env);
      case "connect":
        return await cmdConnect(rest, values, env);
      case "relate":
        return await cmdRelate(values, env);
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
      case "mcp": {
        // Start the stdio server — does not resolve until the connection closes (keeps the process alive).
        // Imported here, not at the top: the MCP SDK is 55ms of startup (measured) and only this
        // one command needs it. Every other invocation — and a hook shelling out to one — pays it
        // for nothing. Same reason `openStore` defers the remote adapters.
        const { runMcp } = await import("../mcp/index.js");
        await runMcp(resolveDb(values, env), env, resolveShards(values, env));
        return 0;
      }
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
    // Only the commands that open a file get the file named. Every other failure happened on the
    // server, and pointing the reader at a local path the command never touched sends them to the
    // wrong machine — the remote's own messages already name the host.
    if (!LOCAL_COMMANDS.has(command)) {
      console.error(msg);
      return 1;
    }
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
    // still in that buffer, so a scripted reader of `--json | jq` silently gets a truncated prefix with
    // exit 0 and no error (a redirect to a file is synchronous, which is why this hides). Setting the
    // code lets node exit on its own once the streams have drained.
    process.exitCode = code;
  });
}
