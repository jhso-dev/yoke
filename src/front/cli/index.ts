#!/usr/bin/env node

// yoke CLI 골격 (PLAN 1.7) — node:util parseArgs만 사용. commander 등 금지.
// 명령 핸들러는 runCli(argv, env)로 분리 — 프로세스 spawn 없이 테스트 가능, exit code는 반환값.
// Date 획득은 이 front 계층에서만 (core는 now를 주입받는다).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { makeGithubPrConnector } from "../../connectors/github-pr.js";
import { ingest } from "../../connectors/ingest.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { makeFetchEmbedder } from "../../core/embedding.js";
import { inject } from "../../core/inject.js";
import { deprecate, verify } from "../../core/lifecycle.js";
import { seedOntology, type TypeDef } from "../../core/ontology.js";
import {
  personaQuery,
  renderPersonaSkill,
  safeName,
} from "../../core/persona.js";
import type { Entity, Relation } from "../../core/types.js";
import { runMcp } from "../mcp/index.js";

type Values = {
  db?: string;
  actor?: string;
  attr?: string[];
  version?: string;
  type?: string;
  limit?: string;
  json?: boolean;
  repo?: string;
  since?: string;
  out?: string;
  "all-drafts"?: boolean;
  "include-draft"?: boolean;
};

const OPTIONS = {
  db: { type: "string" },
  actor: { type: "string" },
  attr: { type: "string", multiple: true },
  version: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  json: { type: "boolean" },
  repo: { type: "string" },
  since: { type: "string" },
  out: { type: "string" },
  "all-drafts": { type: "boolean" },
  "include-draft": { type: "boolean" },
} as const;

type Env = Record<string, string | undefined>;

const now = (): string => new Date().toISOString();

const resolveDb = (v: Values, env: Env): string =>
  v.db ?? env.YOKE_DB ?? "./yoke.db";

const resolveActor = (v: Values, env: Env): string =>
  v.actor ?? env.YOKE_ACTOR ?? "yoke:system";

/** --attr k=v 목록 → attributes. 같은 key 반복 지정 시 string[]. */
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

/** --json이면 기계용 JSON, 아니면 사람용 텍스트. */
function emit(v: Values, human: string, data: unknown): void {
  console.log(v.json ? JSON.stringify(data) : human);
}

function formatEntity(e: Entity | Relation): string {
  return `${e.id}  ${e.type}  ${e.status}  v${e.version}  ${JSON.stringify(e.attributes)}`;
}

/** attributes의 첫 string 값을 60자로 자른 요약 (review/inject 압축 표시용). */
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
    // 재실행 멱등: yoke:system이 이미 있으면 재시드하지 않는다.
    if (await store.getEntity("yoke:system")) {
      emit(v, `already initialized: ${db}`, { db, seeded: false });
      return 0;
    }
    const ontology = seedOntology();
    store.saveOntology(ontology);
    // yoke:system person 시드 — 게이트 우회(putEntity) 금지. commit을 well-known id로.
    // 미존재 id면 version 1 신규 생성되므로 게이트를 정상 통과한다 (부트스트랩).
    const ts = now();
    await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "system" } },
      { actor: "yoke:system", origin: "cli", occurred_at: ts },
      ts,
      { existingId: "yoke:system" },
    );
    // 시스템 person을 draft로 두면 review 큐에 영원히 남는다 — 시드 직후 승격.
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
  const attributes = parseAttrs(v.attr ?? []);
  return withStore(db, async (store) => {
    const ontology = store.loadOntology();
    const ts = now();
    try {
      const { entity, duplicates } = await commit(
        store,
        ontology,
        { type, attributes },
        { actor, origin: "cli", occurred_at: ts },
        ts,
        { embedder: makeFetchEmbedder(env) },
      );
      const human =
        duplicates.length > 0
          ? `${formatEntity(entity)}\n유사 지식 ${duplicates.length}건: ${duplicates.map((d) => d.id).join(" ")}`
          : formatEntity(entity);
      // --json은 entity 그대로 (기존 계약 유지). 유사 지식 경고는 사람용 텍스트에만.
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
  return withStore(db, async (store) => {
    const results = await store.search({ text: query, type: v.type, limit });
    emit(v, results.map(formatEntity).join("\n"), results);
    return 0;
  });
}

async function cmdReview(v: Values, env: Env): Promise<number> {
  const db = resolveDb(v, env);
  return withStore(db, async (store) => {
    const drafts = store
      .listByStatus("draft")
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
  return withStore(db, async (store) => {
    const ids = v["all-drafts"]
      ? store.listByStatus("draft").map((e) => e.id)
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
  return withStore(db, async (store) => {
    const ontology = store.loadOntology();
    const { items } = await inject(store, ontology, query, now(), {
      includeDraft: v["include-draft"],
      limit,
    });
    const lines = items.map(
      (it) => `${it.citation}  ${summarize(it.entity.attributes)}`,
    );
    emit(v, items.length ? lines.join("\n") : "no results", items);
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
    // 각 쌍의 양쪽 entity 요약을 붙여 한 줄로 (해소는 verify/deprecate로 — 전용 명령 없음).
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
  if (sub === "list") {
    return withStore(db, async (store) => {
      const defs = store.loadOntology();
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
      // 기존 name이면 새 버전 = 마이그레이션 (entity와 동일 append-only).
      store.saveOntology([def]);
      emit(v, `saved type: ${def.name}`, def);
      return 0;
    });
  }
  console.error("usage: yoke ontology <list|add-type <json-file>>");
  return 1;
}

async function cmdConnect(
  positionals: string[],
  v: Values,
  env: Env,
): Promise<number> {
  const source = positionals[0];
  if (source !== "github-pr" || !v.repo) {
    console.error(
      "usage: yoke connect github-pr --repo owner/name [--since date] [--actor a]",
    );
    return 1;
  }
  const db = resolveDb(v, env);
  const actor = resolveActor(v, env);
  const connector = makeGithubPrConnector({
    repo: v.repo,
    token: env.GITHUB_TOKEN,
  });
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
  return withStore(db, async (store) => {
    const person = await store.getEntity(id);
    if (!person) {
      console.error(`not found: ${id}`);
      return 1;
    }
    const ontology = store.loadOntology();
    const ts = now();
    const result = await personaQuery(store, ontology, id, ts);
    const md = renderPersonaSkill(person, result, ts);
    // fs는 CLI 계층에서만 (core는 문자열만 생성).
    const outDir = join(v.out ?? ".", `persona-${safeName(id)}`);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, "SKILL.md");
    writeFileSync(file, md);
    const sources = result.decisions.length + result.facts.length;
    emit(v, `saved: ${file}\n소스 지식 ${sources}건`, { path: file, sources });
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
      case "conflicts":
        return await cmdConflicts(values, env);
      case "ontology":
        return await cmdOntology(rest, values, env);
      case "connect":
        return await cmdConnect(rest, values, env);
      case "persona":
        return await cmdPersona(rest, values, env);
      case "mcp":
        // stdio 서버 기동 — 연결이 닫힐 때까지 resolve되지 않는다 (process 유지).
        await runMcp(resolveDb(values, env), env);
        return 0;
      default:
        console.error(
          `unknown command: ${command ?? "(none)"}\nusage: yoke <init|add|get|search|review|verify|deprecate|inject|conflicts|ontology|connect|persona|mcp> ...`,
        );
        return 1;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

// 직접 실행 시에만 구동 (테스트 import 시에는 실행 안 함).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
