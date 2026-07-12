// commit 게이트 테스트 — 실제 SqliteStorage(:memory:)로 게이트 파이프라인을 검증한다.
// PLAN 1.6 케이스: 온톨로지 거절 / provenance 거절 / draft·version=1·last_confirmed /
// 재커밋 version 증가 + 이력 보존 / relation 커밋.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "./commit.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov: Provenance = {
  actor: "yoke:system",
  origin: "cli",
  occurred_at: "2026-07-12T00:00:00Z",
};

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

describe("commit gate", () => {
  it("rejects unregistered ontology type", async () => {
    await expect(
      commit(port, ont, { type: "nope", attributes: {} }, prov, now),
    ).rejects.toMatchObject({ reason: "ontology" });
  });

  it("rejects missing required attribute (ontology)", async () => {
    await expect(
      commit(
        port,
        ont,
        { type: "decision", attributes: { conclusion: "ship" } },
        prov,
        now,
      ),
    ).rejects.toBeInstanceOf(CommitRejected);
  });

  it("rejects empty actor (provenance)", async () => {
    await expect(
      commit(
        port,
        ont,
        { type: "fact", attributes: {} },
        { ...prov, actor: "" },
        now,
      ),
    ).rejects.toMatchObject({ reason: "provenance" });
  });

  it("assigns draft, version=1, last_confirmed=now, empty duplicates", async () => {
    const { entity, duplicates } = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "water boils at 100C" } },
      prov,
      now,
    );
    expect(entity.status).toBe("draft");
    expect(entity.version).toBe(1);
    expect(entity.last_confirmed).toBe(now);
    expect(entity.id).toBeTruthy();
    expect(duplicates).toEqual([]);
    expect(await port.getEntity(entity.id)).toEqual(entity);
  });

  it("re-commit by existingId bumps version and preserves history", async () => {
    const first = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "v1" } },
      prov,
      now,
    );
    const later = "2026-07-13T00:00:00Z";
    const second = await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "v2" } },
      prov,
      later,
      { existingId: first.entity.id },
    );
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.version).toBe(2);
    expect(second.entity.last_confirmed).toBe(later);
    // 이력 보존: 과거 버전 조회 가능
    const v1 = await port.getEntity(first.entity.id, 1);
    expect(v1?.version).toBe(1);
    expect(v1?.attributes).toEqual({ note: "v1" });
    // 최신은 v2
    expect(await port.getEntity(first.entity.id)).toEqual(second.entity);
  });

  it("commits a relation via putRelation", async () => {
    const { entity } = await commit(
      port,
      ont,
      { type: "relates_to", attributes: {}, from: "a", to: "b" },
      prov,
      now,
    );
    expect("from" in entity && entity.from).toBe("a");
    expect(entity.status).toBe("draft");
    const found = await port.neighbors("a", "relates_to", "out");
    expect(found).toEqual([entity]);
  });
});
