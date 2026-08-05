// overview tests — the global-aggregation shape (v5.7), through the real SqliteStorage + gate.
//
// What each case is really pinning: that the numbers describe the CORPUS rather than a retrieval
// window, since the whole reason this exists is that no top-k can answer "what does this know".

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { overview } from "./aggregate.js";
import { commit } from "./commit.js";
import { deprecate, verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov = { actor: "alice", origin: "cli" as const, occurred_at: now };

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

const add = async (
  type: string,
  attributes: Record<string, unknown>,
  actor = "alice",
) =>
  (await commit(port, ont, { type, attributes }, { ...prov, actor }, now))
    .entity.id;

const rel = async (type: string, from: string, to: string) => {
  await commit(port, ont, { type, attributes: {}, from, to }, prov, now);
};

describe("overview", () => {
  it("counts by type and by EFFECTIVE status, not stored status", async () => {
    const fresh = await add("fact", { note: "current" });
    const aging = await add("fact", { note: "will go stale" });
    const gone = await add("fact", { note: "retired" });
    await add("term", { note: "never reviewed" }); // stays draft
    await verify(port, [fresh, aging, gone], "alice", now);
    await deprecate(port, [gone], "alice", now);

    // 200 days on: `fact` TTL is 180, so `aging` and `fresh` are both stale — the point is that this
    // is computed here and stored nowhere, so no query could have reported it.
    const late = await overview(port, ont, "2028-01-28T00:00:00Z");
    expect(late.entities.byType.fact).toEqual({
      draft: 0,
      verified: 0,
      stale: 2,
      deprecated: 1,
    });
    expect(late.entities.byType.term).toEqual({
      draft: 1,
      verified: 0,
      stale: 0,
      deprecated: 0,
    });

    const early = await overview(port, ont, now);
    expect(early.entities.byType.fact.verified).toBe(2);
    expect(early.entities.byType.fact.stale).toBe(0);
    expect(early.entities.total).toBe(4);
  });

  it("ranks hubs by degree, counting both directions", async () => {
    const hub = await add("collaboration", { title: "the centre" });
    const edge = await add("fact", { note: "one link only" });
    const mid = await add("fact", { note: "two links" });
    await rel("relates_to", edge, hub);
    await rel("relates_to", mid, hub);
    await rel("relates_to", mid, edge); // mid: 2, edge: 2, hub: 2 — so make hub clearly biggest
    const third = await add("fact", { note: "third link" });
    await rel("relates_to", third, hub);

    const res = await overview(port, ont, now);
    expect(res.hubs[0].entity.id).toBe(hub);
    // 3, not 4: the gate mirrors authorship into an `authored_by` edge on every record, and counting
    // those would add a constant to everything and put PEOPLE at the top of a list that is supposed to
    // say what knowledge clusters. Same reasoning as "a roster is not knowledge", one surface over.
    expect(res.hubs[0].degree).toBe(3);
    // The whole entity comes back, not an id: a hub list of ULIDs is unreadable, and core does not get
    // to decide how a person reads a record.
    expect(res.hubs[0].entity.attributes.title).toBe("the centre");
    // The census, by contrast, counts every stored relation including the derived ones — it answers
    // "what is in the store", and byType is where a reader sees the split.
    expect(res.relations.byType.relates_to).toBe(4);
    expect(res.relations.byType.authored_by).toBe(4);
    expect(res.relations.total).toBe(8);
  });

  it("attributes only injectable knowledge to its author", async () => {
    const kept = await add("fact", { note: "verified work" }, "bora");
    await add("fact", { note: "still a draft" }, "chul");
    await verify(port, [kept], "admin", now);

    const res = await overview(port, ont, now);
    // `chul` filed a record; nobody confirmed it. Counting drafts would rank whoever files the most,
    // and the question is whose judgment the corpus carries.
    expect(res.authors).toEqual([{ actor: "bora", verified: 1 }]);
    // And promoting is not authoring: `admin` verified it and does not appear.
    expect(res.authors.map((a) => a.actor)).not.toContain("admin");
  });

  it("describes one namespace only", async () => {
    await commit(
      port,
      ont,
      { type: "fact", attributes: { note: "theirs" } },
      prov,
      now,
      { ns: "acme" },
    );
    await add("fact", { note: "mine" });

    const mine = await overview(port, ont, now);
    expect(mine.entities.total).toBe(1);
    const theirs = await overview(port, ont, now, { ns: "acme" });
    expect(theirs.entities.total).toBe(1);
    expect(theirs.entities.byType.fact.draft).toBe(1);
  });

  it("counts everything but ranks only the top N", async () => {
    const hub = await add("collaboration", { title: "centre" });
    for (let i = 0; i < 12; i++) {
      const f = await add("fact", { note: `spoke ${i}` }, `person-${i}`);
      await rel("relates_to", f, hub);
      await verify(port, [f], "admin", now);
    }
    const res = await overview(port, ont, now, { top: 3 });
    expect(res.hubs).toHaveLength(3);
    expect(res.authors).toHaveLength(3);
    // `top` cuts the ranked lists and never the counts — an aggregate over a window is not an aggregate.
    expect(res.entities.byType.fact.verified).toBe(12);
    expect(res.relations.byType.relates_to).toBe(12);
  });

  it("is empty rather than undefined on an empty corpus", async () => {
    const res = await overview(port, ont, now);
    expect(res).toEqual({
      entities: { total: 0, byType: {} },
      relations: { total: 0, byType: {} },
      hubs: [],
      authors: [],
    });
  });
});
