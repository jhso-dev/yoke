#!/usr/bin/env node

// yoke MCP 서버 (PLAN 3.1~3.3) — stdio transport. `yoke mcp [--db path]`로 기동.
// 도구 3개: yoke_inject / yoke_commit / yoke_record_decision.
// 거버넌스: 에이전트는 draft 적재만 가능 (verify/deprecate 도구 없음 — 승격은 CLI 몫).
// Date 획득은 이 front 계층에서만 (core는 now를 주입받는다).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "../../core/commit.js";
import { inject } from "../../core/inject.js";
import type { TypeDef } from "../../core/ontology.js";
import type { EntityInput } from "../../core/types.js";
import type { StoragePort } from "../../ports/storage.js";

const ORIGIN = "mcp";

export interface YokeMcpDeps {
  store: StoragePort;
  ontology: TypeDef[];
  /** 도구 입력에 actor가 없을 때의 기본값 (서버 기동 시 env로 해석). */
  defaultActor: string;
  /** ISO 8601 현재 시각. 기본 new Date().toISOString() — 테스트는 고정값 주입. */
  now?: () => string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ ...ok(text), isError: true });

/** MCP 서버 인스턴스 조립. 테스트는 InMemoryTransport로 이 인스턴스에 연결한다. */
export function createYokeMcpServer(deps: YokeMcpDeps): McpServer {
  const { store, ontology, defaultActor } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const server = new McpServer({ name: "yoke", version: "0.1.0" });

  // 입력 actor > 서버 기동 env(defaultActor) > 'yoke:system'(defaultActor에 이미 반영).
  const resolveActor = (actor?: string) => actor ?? defaultActor;

  async function doCommit(input: EntityInput, actor?: string) {
    const ts = now();
    try {
      const { entity } = await commit(
        store,
        ontology,
        input,
        {
          actor: resolveActor(actor),
          origin: ORIGIN,
          occurred_at: ts,
        },
        ts,
      );
      return ok(
        JSON.stringify({
          id: entity.id,
          version: entity.version,
          status: entity.status,
        }),
      );
    } catch (e) {
      if (e instanceof CommitRejected)
        return err(`rejected (${e.reason}): ${e.message}`);
      throw e;
    }
  }

  server.registerTool(
    "yoke_inject",
    {
      description:
        "작업을 시작하기 전에 이 도구로 관련 지식(과거 결정·사실·용어)을 먼저 조회하라. " +
        "질의어에 매칭되는 verified 지식을 인용과 함께 반환한다. " +
        "includeDraft를 켜면 미검증(draft) 지식도 상태 라벨과 함께 포함한다.",
      inputSchema: {
        query: z.string().describe("검색할 자연어 질의"),
        includeDraft: z
          .boolean()
          .optional()
          .describe("미검증 draft 지식도 포함할지 (기본 false)"),
        limit: z.number().int().positive().optional().describe("최대 결과 수"),
      },
    },
    async ({ query, includeDraft, limit }) => {
      const { items } = await inject(store, ontology, query, now(), {
        includeDraft,
        limit,
      });
      if (items.length === 0)
        return ok(`no verified knowledge found for: ${query}`);
      const blocks = items.map(
        (it) =>
          `${it.citation} [${it.effectiveStatus}]\n${JSON.stringify(it.entity.attributes)}`,
      );
      return ok(blocks.join("\n\n"));
    },
  );

  server.registerTool(
    "yoke_commit",
    {
      description:
        "새로운 지식(사실·용어 등)을 지식 DB에 적재한다. 적재된 지식은 draft 상태로 " +
        "진입하며, 사람의 verify 이후에만 주입 대상이 된다. 온톨로지에 없는 타입이나 " +
        "필수 속성 누락 시 거절된다. 결정을 기록하려면 yoke_record_decision을 사용하라.",
      inputSchema: {
        type: z
          .string()
          .describe("온톨로지에 등록된 entity 타입 (예: fact, term)"),
        attributes: z
          .record(z.string(), z.unknown())
          .describe("타입별 스키마로 검증되는 속성"),
        actor: z
          .string()
          .optional()
          .describe("행위자 id (미지정 시 서버 기본값)"),
      },
    },
    ({ type, attributes, actor }) => doCommit({ type, attributes }, actor),
  );

  server.registerTool(
    "yoke_record_decision",
    {
      description:
        "결정을 내렸으면 그 결론과 근거를 반드시 이 도구로 기록하라. 아키텍처·설계·트레이드오프 " +
        "선택을 한 직후가 호출 시점이다. 기각한 대안이 있으면 함께 남겨 미래의 재논의를 막는다. " +
        "기록은 draft로 진입하며 사람의 verify 이후 주입된다.",
      inputSchema: {
        conclusion: z.string().describe("내린 결론"),
        rationale: z.string().describe("그 결론에 이른 근거"),
        rejected_alternatives: z
          .array(z.string())
          .optional()
          .describe("검토했으나 기각한 대안들"),
        actor: z
          .string()
          .optional()
          .describe("행위자 id (미지정 시 서버 기본값)"),
      },
    },
    ({ conclusion, rationale, rejected_alternatives, actor }) => {
      const attributes: Record<string, unknown> = { conclusion, rationale };
      if (rejected_alternatives)
        attributes.rejected_alternatives = rejected_alternatives;
      return doCommit({ type: "decision", attributes }, actor);
    },
  );

  return server;
}

/** CLI `yoke mcp` 진입점. DB를 열고 온톨로지를 로드해 stdio 서버를 기동한다. */
export async function runMcp(
  db: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const store = new SqliteStorage(db);
  await store.init();
  // init 안 된 DB면 부트스트랩 actor(yoke:system)가 없다 → 에러 후 exit 1.
  if (!(await store.getEntity("yoke:system"))) {
    store.close();
    process.stderr.write(
      `not initialized: ${db}\nrun 'yoke init --db ${db}' first\n`,
    );
    process.exit(1);
  }
  const server = createYokeMcpServer({
    store,
    ontology: store.loadOntology(),
    defaultActor: env.YOKE_ACTOR ?? "yoke:system",
  });
  await server.connect(new StdioServerTransport());
  // 클라이언트가 stdin을 닫을 때까지 대기 (그전엔 runCli가 resolve되지 않아 process가 종료되지 않음).
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  store.close();
}
