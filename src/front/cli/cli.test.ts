// CLI 시나리오 테스트 — runCli를 직접 호출 (프로세스 spawn 불필요, exit code는 반환값).
// 임시 디렉토리 DB로 init→add→get→search 1개 + add 거절(exit 1) 1개.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
});
