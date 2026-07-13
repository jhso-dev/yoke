// MCP E2E (PLAN 3.3) — 두 개의 독립 클라이언트 연결이 같은 DB를 본다(세션 간 지속성).
// spawn 대신 InMemoryTransport 사용(허용됨): 서버·클라이언트를 링크된 페어로 연결하되,
// 각 연결마다 DB 파일을 새로 여닫아 "Client A 커밋 → 닫기 → Client B 조회" 시나리오를 유지한다.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { runCli } from "../cli/index.js";
import { createYokeMcpServer } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-mcp-"));
const db = join(dir, "yoke.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** DB 파일에 대해 서버+클라이언트를 새로 열어 연결한다 (독립 세션 1개). */
async function openSession() {
  const store = new SqliteStorage(db);
  await store.init();
  const server = createYokeMcpServer({
    store,
    ontology: store.loadOntology(),
    defaultActor: "yoke:system",
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      store.close();
    },
  };
}

function text(r: unknown): string {
  const content = (r as { content: Array<{ type: string; text: string }> })
    .content;
  return content.map((c) => c.text).join("\n");
}

beforeAll(async () => {
  expect(await runCli(["init", "--db", db])).toBe(0);
});

describe("yoke MCP server", () => {
  it("Client A가 기록한 결정을 별도 Client B가 (draft로) 본다", async () => {
    // (A) 결정 기록 → 연결 종료
    const a = await openSession();
    const rec = await a.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "use sqlitembed for storage",
        rationale: "single-file embeddable store keeps the CLI zero-config",
        rejected_alternatives: ["postgres"],
      },
    });
    expect(rec.isError).toBeFalsy();
    expect(text(rec)).toMatch(/"status":"draft"/);
    await a.close();

    // (B) 별도 연결에서 조회 — draft라 기본 inject엔 안 나온다
    const b = await openSession();
    const def = await b.client.callTool({
      name: "yoke_inject",
      arguments: { query: "sqlitembed" },
    });
    expect(text(def)).toContain("no verified knowledge found");

    // includeDraft로는 나온다 (상태 라벨 + attributes 포함)
    const withDraft = await b.client.callTool({
      name: "yoke_inject",
      arguments: { query: "sqlitembed", includeDraft: true },
    });
    const out = text(withDraft);
    expect(out).toContain("[draft]");
    expect(out).toContain("use sqlitembed for storage");
    await b.close();
  });

  it("yoke_commit: 미등록 타입은 도구 에러로 거절된다", async () => {
    const s = await openSession();
    const bad = await s.client.callTool({
      name: "yoke_commit",
      arguments: { type: "nonesuch", attributes: { x: 1 } },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("rejected (ontology)");

    const good = await s.client.callTool({
      name: "yoke_commit",
      arguments: { type: "fact", attributes: { title: "hello" } },
    });
    expect(good.isError).toBeFalsy();
    expect(text(good)).toMatch(/"status":"draft"/);
    await s.close();
  });

  it("verify/deprecate 도구는 노출하지 않는다 (거버넌스: 에이전트는 draft 적재만)", async () => {
    const s = await openSession();
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "yoke_commit",
      "yoke_inject",
      "yoke_persona",
      "yoke_record_decision",
    ]);
    await s.close();
  });

  it("yoke_persona: 인물 verified 결정을 인용과 함께 반환, 미존재 인물은 도구 에러", async () => {
    // yoke:system 이 결정을 기록하고 (같은 actor로) verify → persona에 잡힌다.
    const seed = await openSession();
    const rec = await seed.client.callTool({
      name: "yoke_record_decision",
      arguments: {
        conclusion: "adopt append-only storage",
        rationale: "audit trail requires immutable history",
      },
    });
    const id = JSON.parse(text(rec)).id as string;
    await seed.close();
    // verify는 CLI 몫 — actor를 yoke:system으로 유지해 provenance.actor 매칭이 살아있게.
    expect(
      await runCli(["verify", id, "--db", db, "--actor", "yoke:system"]),
    ).toBe(0);

    const s = await openSession();
    const res = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "yoke:system" },
    });
    expect(res.isError).toBeFalsy();
    const out = text(res);
    expect(out).toContain("adopt append-only storage");
    expect(out).toContain(id); // citation

    // query 필터: 매칭 없으면 '기록 없음'
    const filtered = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "yoke:system", query: "nonexistent-topic-xyz" },
    });
    expect(text(filtered)).toContain("기록 없음");

    // 미존재 인물 → 도구 에러
    const missing = await s.client.callTool({
      name: "yoke_persona",
      arguments: { person: "nobody" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("person not found");
    await s.close();
  });
});
