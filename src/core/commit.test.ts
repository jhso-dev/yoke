// commit gate tests — exercise the gate pipeline against the real SqliteStorage(:memory:).
// PLAN 1.6 cases: ontology rejection / provenance rejection / draft·version=1·last_confirmed /
// re-commit version bump + history preservation / relation commit.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { CommitRejected, commit } from "./commit.js";
import type { Embedder } from "./embedding.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov: Provenance = {
  actor: "yoke:system",
  origin: "cli",
  occurred_at: "2026-07-12T00:00:00Z",
};

// Deterministic stub embedder — a bag-of-words hash. Same word set → same vector.
// The more the text overlaps, the higher the cosine (exercises gate stages 3 & 4 deterministically without a real API).
const stubEmbedder: Embedder = async (text) => {
  const v = new Float32Array(64);
  for (const w of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
};

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

/**
 * Endpoints for the relation cases: the gate rejects an edge to an id that is not a record.
 *
 * Stored straight through the port rather than committed, because a commit also mirrors its own
 * authorship — an extra `authored_by` out-edge per endpoint, which the edge counts below would then
 * be counting.
 */
async function nodes(...ids: string[]): Promise<void> {
  for (const id of ids)
    await port.putEntity({
      id,
      type: "fact",
      attributes: { statement: id },
      status: "verified",
      version: 1,
      last_confirmed: now,
      provenance: prov,
    });
}

describe("attachTo", () => {
  it("writes nothing when the attachment target is not a record", async () => {
    // The regression this exists for: the edge used to be a second commit at the front tier, so the
    // entity was already durable when the endpoint check threw. The caller heard "rejected" about a
    // record that existed, and an agent that retries on a rejection doubles the corpus.
    await expect(
      commit(
        port,
        ont,
        { type: "fact", attributes: { statement: "orphan probe" } },
        prov,
        now,
        { attachTo: "01NOSUCHRECORD0000000000" },
      ),
    ).rejects.toMatchObject({ reason: "ontology" });
    expect((await port.listEntities({})).items).toEqual([]);
  });

  it("files one relates_to edge to the target", async () => {
    await nodes("collab");
    const { entity, attached } = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "attached knowledge" } },
      prov,
      now,
      { attachTo: "collab" },
    );
    expect(attached).toMatchObject({
      type: "relates_to",
      from: entity.id,
      to: "collab",
    });
    const edges = await port.neighbors(entity.id, "relates_to");
    expect(edges).toHaveLength(1);
  });

  it("attaching the same pair twice is one edge", async () => {
    // relates_to is symmetric, so the second attach must find the first rather than file the mirror.
    await nodes("collab");
    const first = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "first" } },
      prov,
      now,
      { attachTo: "collab" },
    );
    const again = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "first" } },
      prov,
      now,
      { existingId: first.entity.id, attachTo: "collab" },
    );
    expect(again.attached?.id).toBe(first.attached?.id);
    expect(await port.neighbors(first.entity.id, "relates_to")).toHaveLength(1);
  });
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
        // A valid record, so the rejection under test is the provenance one and not the ontology's:
        // the gate checks the type first, and an empty fact now fails there.
        {
          type: "fact",
          attributes: { statement: "the pool drains at midnight" },
        },
        { ...prov, actor: "" },
        now,
      ),
    ).rejects.toMatchObject({ reason: "provenance" });
  });

  it("assigns draft, version=1, last_confirmed=now, empty duplicates", async () => {
    const { entity, duplicates } = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "water boils at 100C" } },
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
      { type: "fact", attributes: { statement: "v1" } },
      prov,
      now,
    );
    const later = "2026-07-13T00:00:00Z";
    const second = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "v2" } },
      prov,
      later,
      { existingId: first.entity.id },
    );
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.version).toBe(2);
    expect(second.entity.last_confirmed).toBe(later);
    // History preserved: the past version is still queryable.
    const v1 = await port.getEntity(first.entity.id, 1);
    expect(v1?.version).toBe(1);
    expect(v1?.attributes).toEqual({ statement: "v1" });
    // Latest is v2.
    expect(await port.getEntity(first.entity.id)).toEqual(second.entity);
  });

  it("commits a relation via putRelation", async () => {
    await nodes("a", "b");
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

  // A relation's identity is (type, from, to) in a namespace. Pressing Link twice used to store two
  // rows with different ids, the same actor and the same instant — the entity screen listed the link
  // three times, the graph drew three arrows over each other, and a collaboration counted one
  // attached record as three.
  it("commits the same edge once, and says it was already there", async () => {
    await nodes("x", "y");
    const input = {
      type: "relates_to" as const,
      attributes: {},
      from: "x",
      to: "y",
    };
    const first = await commit(port, ont, input, prov, now);
    expect(first.existed).toBeUndefined();

    const again = await commit(port, ont, input, prov, now);
    expect(again.existed).toBe(true);
    // The SAME edge comes back — a caller that stores the returned id keeps pointing at one row.
    expect(again.entity.id).toBe(first.entity.id);
    expect(await port.neighbors("x", "relates_to", "out")).toHaveLength(1);
  });

  // Direction is not a claim for a symmetric relation, so recording it the other way round is not a
  // second fact. Without this, the link control's direction toggle turned one claim into two rows.
  it("treats a symmetric relation as one edge whichever way it was recorded", async () => {
    await nodes("m", "n");
    await commit(
      port,
      ont,
      { type: "relates_to", attributes: {}, from: "m", to: "n" },
      prov,
      now,
    );
    const reverse = await commit(
      port,
      ont,
      { type: "relates_to", attributes: {}, from: "n", to: "m" },
      prov,
      now,
    );
    expect(reverse.existed).toBe(true);
    expect(await port.neighbors("m", "relates_to")).toHaveLength(1);
    // The stored row keeps the direction it was recorded with — provenance is not rewritten.
    expect("from" in reverse.entity && reverse.entity.from).toBe("m");
  });

  it("still treats a DIRECTIONAL relation's two ways round as two edges", async () => {
    await nodes("new", "old");
    // `supersedes` is the counter-case: which record supersedes which is the whole content.
    await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: "new", to: "old" },
      prov,
      now,
    );
    const back = await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: "old", to: "new" },
      prov,
      now,
    );
    expect(back.existed).toBeUndefined();
    expect(await port.neighbors("new", "supersedes")).toHaveLength(2);
  });

  it("keeps edges that differ in type, in direction, or in namespace", async () => {
    await nodes("p", "q");
    const base = { attributes: {}, from: "p", to: "q" };
    await commit(port, ont, { ...base, type: "relates_to" }, prov, now);
    // A different type between the same two records is a different claim.
    await commit(port, ont, { ...base, type: "supersedes" }, prov, now);
    // The reverse edge is its own edge: for `supersedes` the direction IS the claim.
    await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: "q", to: "p" },
      prov,
      now,
    );
    // And a namespace is a separate world — the same pair there is not this pair.
    await commit(port, ont, { ...base, type: "relates_to" }, prov, now, {
      ns: "other",
    });
    expect(await port.neighbors("p", undefined, "out")).toHaveLength(3);
    expect(await port.neighbors("q", "supersedes", "out")).toHaveLength(1);
  });
});

describe("commit gate stage 3 (duplicates)", () => {
  const facts = {
    statement: "water boils at one hundred celsius everywhere always",
  };

  it("returns similar entity as duplicate when >= threshold (embedding)", async () => {
    const first = await commit(
      port,
      ont,
      { type: "fact", attributes: facts },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    const second = await commit(
      port,
      ont,
      { type: "fact", attributes: facts },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    expect(second.duplicateDetection).toBe("embedding");
    expect(second.duplicates.map((d) => d.id)).toContain(first.entity.id);
  });

  it("returns empty duplicates when below threshold", async () => {
    await commit(
      port,
      ont,
      {
        type: "fact",
        attributes: { statement: "cats are small furry mammals" },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    const other = await commit(
      port,
      ont,
      {
        type: "fact",
        attributes: { statement: "quantum tunneling barrier probability" },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    expect(other.duplicateDetection).toBe("embedding");
    expect(other.duplicates).toEqual([]);
  });

  it("skips duplicate detection on FTS fallback (no embedder) — empty even if identical", async () => {
    await commit(port, ont, { type: "fact", attributes: facts }, prov, now);
    const second = await commit(
      port,
      ont,
      { type: "fact", attributes: facts },
      prov,
      now,
    );
    expect(second.duplicateDetection).toBe("skipped");
    expect(second.duplicates).toEqual([]);
  });
});

describe("commit gate stage 4 (decision conflict)", () => {
  const rationale =
    "the team already runs this database in production and staging across every region";

  it("creates conflicts_with when a similar decision has a different conclusion, preserving both", async () => {
    const a = await commit(
      port,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "adopt postgres", rationale },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    const b = await commit(
      port,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "adopt mysql", rationale },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    // conflicts_with created
    expect(b.conflicts).toBeDefined();
    expect(b.conflicts?.length).toBe(1);
    const rel = b.conflicts?.[0];
    expect(rel?.type).toBe("conflicts_with");
    expect(rel?.from).toBe(b.entity.id);
    expect(rel?.to).toBe(a.entity.id);
    // Also reachable via neighbors.
    const rels = await port.neighbors(b.entity.id, "conflicts_with", "out");
    expect(rels.map((r) => r.to)).toContain(a.entity.id);
    // Both preserved: both still exist and neither is deprecated (no auto-resolution).
    expect((await port.getEntity(a.entity.id))?.status).not.toBe("deprecated");
    expect((await port.getEntity(b.entity.id))?.status).not.toBe("deprecated");
  });

  it("does not create conflicts_with when conclusions match (duplicate, not conflict)", async () => {
    await commit(
      port,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "adopt postgres", rationale },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    const b = await commit(
      port,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "adopt postgres", rationale },
      },
      prov,
      now,
      { embedder: stubEmbedder },
    );
    expect(b.duplicates.length).toBeGreaterThan(0); // caught as similar (duplicate)
    expect(b.conflicts).toBeUndefined(); // but not a conflict
  });
});

// Stage 4b — provenance mirrored into the graph. This is what lets a person anchor an injection
// exactly like a collaboration does (one mechanism), so the edge is part of the gate's contract.
describe("authorship edge", () => {
  const add = (attributes: Record<string, unknown>, actor: string) =>
    commit(port, ont, { type: "fact", attributes }, { ...prov, actor }, now);

  it("records authored_by from the entity to its provenance actor", async () => {
    const { entity } = await add({ statement: "ships fridays" }, "alex");
    const rels = await port.neighbors(entity.id, "authored_by", "out");
    expect(rels.map((r) => r.to)).toEqual(["alex"]);
    // Reachable from the person's side too — the direction persona traverses.
    const inbound = await port.neighbors("alex", "authored_by", "in");
    expect(inbound.map((r) => r.from)).toEqual([entity.id]);
  });

  it("does not duplicate the edge when the same author re-commits", async () => {
    const { entity } = await add({ statement: "v1" }, "alex");
    await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "v2" } },
      { ...prov, actor: "alex" },
      now,
      { existingId: entity.id },
    );
    expect((await port.neighbors(entity.id, "authored_by", "out")).length).toBe(
      1,
    );
  });

  it("adds a second edge when a different author re-commits", async () => {
    const { entity } = await add({ statement: "v1" }, "alex");
    await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "v2" } },
      { ...prov, actor: "kim" },
      now,
      { existingId: entity.id },
    );
    const rels = await port.neighbors(entity.id, "authored_by", "out");
    expect(rels.map((r) => r.to).sort()).toEqual(["alex", "kim"]);
  });

  it("does not author relations, and never authors an entity to itself", async () => {
    const { entity } = await add({ statement: "anchor" }, "alex");
    // The authored_by relation itself must not get an authorship edge (that would recurse).
    const [edge] = await port.neighbors(entity.id, "authored_by", "out");
    expect((await port.neighbors(edge.id, "authored_by", "out")).length).toBe(
      0,
    );
    // A person seeded with its own id as actor (the yoke:system bootstrap) gets no self-edge.
    const self = await commit(
      port,
      ont,
      { type: "person", attributes: { name: "system" } },
      prov,
      now,
      { existingId: "yoke:system" },
    );
    expect(
      (await port.neighbors(self.entity.id, "authored_by", "out")).length,
    ).toBe(0);
  });
});
