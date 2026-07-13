// inject 테스트 — 실제 SqliteStorage(:memory:) + commit 게이트로 데이터 준비.
// draft 제외 / verify 후 포함 / includeDraft 라벨 / TTL 경과 verified 제외 / citation 형식.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { inject } from "./inject.js";
import { verify } from "./lifecycle.js";
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

describe("inject", () => {
  it("excludes drafts by default", async () => {
    await addFact("draft knowledge");
    const { items } = await inject(port, ont, "draft", now);
    expect(items).toEqual([]);
  });

  it("includes an entity after it is verified", async () => {
    const id = await addFact("verified knowledge");
    await verify(port, [id], "alice", now);
    const { items } = await inject(port, ont, "verified", now);
    expect(items).toHaveLength(1);
    expect(items[0].entity.id).toBe(id);
    expect(items[0].effectiveStatus).toBe("verified");
  });

  it("includes drafts with their status label when includeDraft is set", async () => {
    await addFact("draft knowledge");
    const { items } = await inject(port, ont, "draft", now, {
      includeDraft: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0].effectiveStatus).toBe("draft");
  });

  it("excludes verified entities that have gone stale (TTL exceeded)", async () => {
    const id = await addFact("aging knowledge");
    await verify(port, [id], "alice", now); // fact TTL = 180일
    const { items } = await inject(port, ont, "aging", "2027-01-10T00:00:00Z");
    expect(items).toEqual([]);
  });

  it("produces the exact citation format for one verified item", async () => {
    const id = await addFact("citable");
    await verify(port, [id], "alice", "2026-07-13T00:00:00Z");
    const { items } = await inject(
      port,
      ont,
      "citable",
      "2026-07-13T00:00:00Z",
    );
    expect(items).toHaveLength(1);
    expect(items[0].citation).toBe(
      `[fact:${id}@v2] alice, 2026-07-13T00:00:00Z`,
    );
  });
});
