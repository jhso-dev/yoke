// CLI 시나리오 테스트 — runCli를 직접 호출 (프로세스 spawn 불필요, exit code는 반환값).
// 임시 디렉토리 DB로 init→add→get→search 1개 + add 거절(exit 1) 1개.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import type { Provenance } from "../../core/types.js";
import { runCli } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
    errs.push(String(m));
  });
});

function newDb(): string {
  return join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("runCli", () => {
  it("init → add → get → search round-trip", async () => {
    const db = newDb();

    expect(await runCli(["init", "--db", db])).toBe(0);

    // 재실행 멱등: 재시드하지 않는다.
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(logs.at(-1)).toContain("already initialized");

    // add (--json으로 id 확보)
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=hello",
        "--json",
      ]),
    ).toBe(0);
    const added = JSON.parse(logs.at(-1) as string);
    expect(added.type).toBe("fact");
    expect(added.status).toBe("draft");
    expect(added.attributes.title).toBe("hello");

    // get
    expect(await runCli(["get", added.id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).id).toBe(added.id);

    // 미존재 get → exit 1
    expect(await runCli(["get", "nope", "--db", db])).toBe(1);

    // search
    expect(await runCli(["search", "hello", "--db", db, "--json"])).toBe(0);
    const found = JSON.parse(logs.at(-1) as string);
    expect(found.some((e: { id: string }) => e.id === added.id)).toBe(true);
  });

  it("rejects invalid add with exit 1", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // decision은 conclusion/rationale required → 누락 시 게이트 거절.
    expect(await runCli(["add", "decision", "--db", db])).toBe(1);
    expect(errs.at(-1)).toContain("rejected");
  });

  it("lifecycle E2E: add(draft) → inject 제외 → review → verify → inject 노출 → deprecate → 제외", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // add → draft
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=lifecycletoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;

    // draft는 기본 inject에서 제외
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);

    // --include-draft면 노출
    expect(
      await runCli([
        "inject",
        "lifecycletoken",
        "--db",
        db,
        "--include-draft",
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(1);

    // review에 draft가 뜬다
    expect(await runCli(["review", "--db", db, "--json"])).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).some(
        (e: { id: string }) => e.id === id,
      ),
    ).toBe(true);

    // verify → 승격
    expect(await runCli(["verify", id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)[0].status).toBe("verified");

    // review에서 이 fact는 사라진다 (yoke:system draft는 남아있을 수 있음)
    expect(await runCli(["review", "--db", db, "--json"])).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).some(
        (e: { id: string }) => e.id === id,
      ),
    ).toBe(false);

    // verified → 기본 inject에 노출 (citation 포함)
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    const injected = JSON.parse(logs.at(-1) as string);
    expect(injected).toHaveLength(1);
    expect(injected[0].citation).toContain(id);

    // deprecate → inject에서 사라짐
    expect(await runCli(["deprecate", id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)[0].status).toBe("deprecated");
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);
  });

  it("verify --all-drafts promotes every draft", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    for (const t of ["alpha", "beta"]) {
      expect(
        await runCli(["add", "fact", "--db", db, "--attr", `title=${t}`]),
      ).toBe(0);
    }
    expect(await runCli(["verify", "--all-drafts", "--db", db, "--json"])).toBe(
      0,
    );
    // yoke:system person(draft) + fact 2개 = 3건 승격
    expect(JSON.parse(logs.at(-1) as string).length).toBeGreaterThanOrEqual(2);
    expect(await runCli(["review", "--db", db])).toBe(0);
    expect(logs.at(-1)).toBe("no drafts");
  });

  it("conflicts lists conflicts_with pairs with both entities", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // 두 모순 decision + conflicts_with relation을 게이트 경유로 직접 시드.
    const ont = seedOntology();
    const now = "2026-07-12T00:00:00Z";
    const prov: Provenance = {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: now,
    };
    const store = new SqliteStorage(db);
    await store.init();
    const a = await commit(
      store,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "use postgres", rationale: "r" },
      },
      prov,
      now,
    );
    const b = await commit(
      store,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "use mysql", rationale: "r" },
      },
      prov,
      now,
    );
    await commit(
      store,
      ont,
      {
        type: "conflicts_with",
        attributes: {},
        from: b.entity.id,
        to: a.entity.id,
      },
      prov,
      now,
    );
    store.close();

    expect(await runCli(["conflicts", "--db", db, "--json"])).toBe(0);
    const out = JSON.parse(logs.at(-1) as string);
    expect(out).toHaveLength(1);
    expect(out[0].from.id).toBe(b.entity.id);
    expect(out[0].to.id).toBe(a.entity.id);

    // no conflicts인 새 DB
    const db2 = newDb();
    expect(await runCli(["init", "--db", db2])).toBe(0);
    expect(await runCli(["conflicts", "--db", db2])).toBe(0);
    expect(logs.at(-1)).toBe("no conflicts");
  });

  it("ontology list + add-type (migration = new version)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // list에 시드 타입이 뜬다
    expect(await runCli(["ontology", "list", "--db", db, "--json"])).toBe(0);
    const listed = JSON.parse(logs.at(-1) as string);
    expect(listed.some((d: { name: string }) => d.name === "decision")).toBe(
      true,
    );

    // add-type: 새 타입 JSON 파일
    const file = join(dir, "meeting.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "meeting",
        kind: "entity",
        attrs: { topic: { type: "string", required: true } },
        ttl_days: 90,
      }),
    );
    expect(await runCli(["ontology", "add-type", file, "--db", db])).toBe(0);
    expect(logs.at(-1)).toContain("meeting");

    // list에 새 타입 반영
    expect(await runCli(["ontology", "list", "--db", db, "--json"])).toBe(0);
    const after = JSON.parse(logs.at(-1) as string);
    expect(after.some((d: { name: string }) => d.name === "meeting")).toBe(
      true,
    );

    // add-type 파일 누락 → exit 1
    expect(await runCli(["ontology", "add-type", "--db", db])).toBe(1);
  });
});
