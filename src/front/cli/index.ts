#!/usr/bin/env node

// yoke CLI 골격 (PLAN 1.7) — node:util parseArgs만 사용. commander 등 금지.
// 명령 핸들러는 runCli(argv, env)로 분리 — 프로세스 spawn 없이 테스트 가능, exit code는 반환값.
// Date 획득은 이 front 계층에서만 (core는 now를 주입받는다).

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";

type Values = {
  db?: string;
  actor?: string;
  attr?: string[];
  version?: string;
  type?: string;
  limit?: string;
  json?: boolean;
};

const OPTIONS = {
  db: { type: "string" },
  actor: { type: "string" },
  attr: { type: "string", multiple: true },
  version: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  json: { type: "boolean" },
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
      const { entity } = await commit(
        store,
        ontology,
        { type, attributes },
        { actor, origin: "cli", occurred_at: ts },
        ts,
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
      default:
        console.error(
          `unknown command: ${command ?? "(none)"}\nusage: yoke <init|add|get|search> ...`,
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
