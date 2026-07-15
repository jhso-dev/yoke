// inject tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// draft exclusion / inclusion after verify / includeDraft label / TTL-expired verified exclusion / citation format.

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

/** relates_to link from → to (the capture-side link the front tiers create). */
async function link(from: string, to: string) {
  await commit(
    port,
    ont,
    { type: "relates_to", attributes: {}, from, to },
    prov,
    now,
  );
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
    await verify(port, [id], "alice", now); // fact TTL = 180 days
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

describe("inject scoped (v4.0)", () => {
  // A workstream scope with linked/unlinked, verified/draft facts around it.
  async function scene() {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "workstream", attributes: { title: "auth revamp" } },
      prov,
      now,
    );
    const linkedVerified = await addFact("alpha linked verified");
    const linkedDraft = await addFact("beta linked draft");
    const linkedOther = await addFact("gamma linked verified");
    const unlinked = await addFact("alpha unlinked verified");
    await link(linkedVerified, ws.id);
    await link(linkedDraft, ws.id);
    await link(linkedOther, ws.id);
    await verify(
      port,
      [ws.id, linkedVerified, linkedOther, unlinked],
      "alice",
      now,
    );
    return { ws: ws.id, linkedVerified, linkedDraft, linkedOther, unlinked };
  }

  it("returns only linked verified knowledge (draft and unlinked excluded)", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "", now, { scope: s.ws });
    expect(items.map((i) => i.entity.id).sort()).toEqual(
      [s.linkedVerified, s.linkedOther].sort(),
    );
  });

  it("with a query, returns all query hits with scope-linked ones first (scope prioritizes, not imprisons)", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "alpha", now, { scope: s.ws });
    // Both "alpha" facts match; the scope-linked one leads, the org-wide one still flows in.
    // "gamma" is linked but off-query → excluded (query relevance still gates).
    expect(items.map((i) => i.entity.id)).toEqual([
      s.linkedVerified,
      s.unlinked,
    ]);
  });

  it("includes a linked draft only with includeDraft", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "", now, {
      scope: s.ws,
      includeDraft: true,
    });
    expect(items.map((i) => i.entity.id)).toContain(s.linkedDraft);
  });

  it("never returns the scope entity itself (self-loop is skipped)", async () => {
    const s = await scene();
    await link(s.ws, s.ws); // self relation
    const { items } = await inject(port, ont, "", now, { scope: s.ws });
    expect(items.map((i) => i.entity.id)).not.toContain(s.ws);
  });

  it("unknown scope id yields no results", async () => {
    await scene();
    const { items } = await inject(port, ont, "", now, { scope: "no-such-id" });
    expect(items).toEqual([]);
  });

  it("limit applies after filtering", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "", now, {
      scope: s.ws,
      limit: 1,
    });
    expect(items).toHaveLength(1);
  });
});
