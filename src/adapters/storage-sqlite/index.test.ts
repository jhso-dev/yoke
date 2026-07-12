// storage-sqlite 테스트 — conformance 스위트를 :memory:와 임시 파일 양쪽으로 돌리고,
// 온톨로지 저장/로드 왕복을 확인한다.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { seedOntology } from "../../core/ontology.js";
import { describeStoragePort } from "../../ports/conformance.js";
import { SqliteStorage } from "./index.js";

describeStoragePort(":memory:", async () => new SqliteStorage(":memory:"));

const dir = mkdtempSync(join(tmpdir(), "yoke-sqlite-"));
describeStoragePort("temp file", async () => {
  const path = join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  return new SqliteStorage(path);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ontology save/load", () => {
  it("round-trips the seed ontology", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const seed = seedOntology();
    store.saveOntology(seed);
    expect(store.loadOntology()).toEqual(seed);
    store.close();
  });
});
