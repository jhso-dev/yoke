// lifecycle 테스트 — 실제 SqliteStorage(:memory:) + commit 게이트로 데이터 준비.
// verify 버전 증가+이력 보존 / TTL 경과 stale / ttl 미지정 무제한 / deprecate / 미존재 에러.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { deprecate, effectiveStatus, isFresh, verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov: Provenance = {
  actor: "yoke:system",
  origin: "cli",
  occurred_at: now,
};

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

async function addFact(note: string) {
  const { entity } = await commit(
    port,
    ont,
    { type: "fact", attributes: { note } },
    prov,
    now,
  );
  return entity.id;
}

describe("lifecycle", () => {
  it("verify bumps version, sets verified, preserves history and lifecycle provenance", async () => {
    const id = await addFact("water boils at 100C");
    const later = "2026-07-13T00:00:00Z";
    const [v] = await verify(port, [id], "alice", later);

    expect(v.status).toBe("verified");
    expect(v.version).toBe(2);
    expect(v.last_confirmed).toBe(later);
    expect(v.provenance).toEqual({
      actor: "alice",
      origin: "lifecycle",
      occurred_at: later,
    });
    // 이력 보존: draft였던 v1 그대로 조회 가능
    const v1 = await port.getEntity(id, 1);
    expect(v1?.status).toBe("draft");
    // 최신은 verified v2
    expect((await port.getEntity(id))?.status).toBe("verified");
  });

  it("effectiveStatus is 'stale' when verified fact exceeds its TTL", async () => {
    const id = await addFact("stale-able");
    await verify(port, [id], "alice", now); // fact TTL = 180일
    const e = await port.getEntity(id);
    if (!e) throw new Error("missing");

    // 179일 후: 신선
    expect(effectiveStatus(e, ont, "2027-01-07T00:00:00Z")).toBe("verified");
    // 181일 후: stale (저장은 verified 그대로)
    expect(isFresh(e, ont, "2027-01-10T00:00:00Z")).toBe(false);
    expect(effectiveStatus(e, ont, "2027-01-10T00:00:00Z")).toBe("stale");
    expect(e.status).toBe("verified");
  });

  it("type without ttl_days is fresh forever", async () => {
    const { entity } = await commit(
      port,
      ont,
      { type: "term", attributes: {} },
      prov,
      now,
    );
    const [v] = await verify(port, [entity.id], "alice", now);
    expect(isFresh(v, ont, "2099-01-01T00:00:00Z")).toBe(true);
    expect(effectiveStatus(v, ont, "2099-01-01T00:00:00Z")).toBe("verified");
  });

  it("deprecate sets deprecated via a new version", async () => {
    const id = await addFact("obsolete");
    const [d] = await deprecate(port, [id], "alice", now);
    expect(d.status).toBe("deprecated");
    expect(d.version).toBe(2);
    expect((await port.getEntity(id))?.status).toBe("deprecated");
  });

  it("throws on unknown id (no silent skip)", async () => {
    await expect(verify(port, ["nope"], "alice", now)).rejects.toThrow(/nope/);
  });
});
