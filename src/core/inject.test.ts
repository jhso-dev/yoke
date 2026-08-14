// inject tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// draft exclusion / inclusion after verify / includeDraft label / TTL-expired verified exclusion / citation format.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import type { Embedder } from "./embedding.js";
import { inject, WALK_BUDGET } from "./inject.js";
import { deprecate, verify } from "./lifecycle.js";
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

async function addFact(statement: string) {
  const { entity } = await commit(
    port,
    ont,
    { type: "fact", attributes: { statement } },
    prov,
    now,
  );
  return entity.id;
}

/** Same, but embedded at commit time — so the vector index has a row to find. `ns` puts it in
 * another tenant, which is how the cross-namespace check gets a record it must not return. */
async function addFactWith(statement: string, embedder: Embedder, ns?: string) {
  const { entity } = await commit(
    port,
    ont,
    { type: "fact", attributes: { statement } },
    prov,
    now,
    { embedder, ns },
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

  it("names the author and the person who confirmed it, when they differ", async () => {
    // This asserted `alice` alone — the PROMOTER, because `verify` appends a version whose provenance is
    // the promotion. The fixture's author is `yoke:system`, so the citation named someone who never
    // wrote the record. SPEC:682 states the rule ("authorship comes off the `authored_by` edge, never
    // `provenance.actor` … an authors list built from it ranks reviewers, calls them authors"), and
    // `overview` obeys it while the citation did not. Measured on the real shape: a decision authored
    // under a person's id and verified by a reviewer was served inside that person's persona citing
    // `yoke:system`, so an agent quoting yoke named the wrong person.
    //
    // Both, rather than swapping one for the other — who vouched for this is the other half of what
    // makes a citation auditable.
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
      `[fact:${id}@v2] yoke:system (confirmed by alice), 2026-07-13T00:00:00Z`,
    );
  });

  it("stays the plain format when the author confirmed their own record", async () => {
    // The single-user local path, which is every ungated install: one actor, so there is nothing to
    // distinguish and the citation reads exactly as it always has. This is also why the defect above
    // went unnoticed — it is invisible until a second person exists.
    const id = await addFact("self-confirmed");
    await verify(port, [id], "yoke:system", "2026-07-13T00:00:00Z");
    const { items } = await inject(
      port,
      ont,
      "self-confirmed",
      "2026-07-13T00:00:00Z",
    );
    expect(items[0].citation).toBe(
      `[fact:${id}@v2] yoke:system, 2026-07-13T00:00:00Z`,
    );
  });
});

describe("inject scoped (v4.0)", () => {
  // A collaboration scope with linked/unlinked, verified/draft facts around it.
  async function scene() {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "auth revamp" } },
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

  it("excludes whoever filed the anchor (the anchor's own authorship is not its context)", async () => {
    // The gate records authorship on every entity, so the anchor has an authored_by edge pointing at
    // its author. That person is metadata about the anchor, not knowledge in the working context.
    await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Alice" } },
      prov,
      now,
      { existingId: "alice" },
    );
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "payments" } },
      { ...prov, actor: "alice" },
      now,
    );
    const fact = await addFact("delta linked verified");
    await link(fact, ws.id);
    await verify(port, [ws.id, fact, "alice"], "alice", now);

    const { items } = await inject(port, ont, "", now, { scope: ws.id });
    expect(items.map((i) => i.entity.id)).toEqual([fact]);
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
    // Written straight through the port, because the gate refuses a self-edge now — and a row from before
    // that guard is exactly what this reader-side check is for. Defence in depth: the writer stops new
    // ones, the reader survives old ones.
    await port.putRelation({
      id: "self-edge",
      type: "relates_to",
      from: s.ws,
      to: s.ws,
      attributes: {},
      status: "verified",
      version: 1,
      last_confirmed: now,
      provenance: prov,
    });
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

// Multi-hop (v5.7). "What replaced the thing that replaced this" is two hops, and one hop answered it
// with silence — the shape docs/RESEARCH.md §5 says graph retrieval measurably wins on.
describe("inject scoped: multi-hop", () => {
  /**
   * A chain: anchor -> a -> b -> c, each link a plain relates_to.
   *
   * Minted in REVERSE (c first) on purpose. ULIDs ascend with creation, so creating a, b, c in chain
   * order would make id order and distance order the same sequence — and every ordering assertion
   * below would pass on the pre-existing `id` tiebreak alone, proving nothing about distance.
   */
  async function chain() {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "gateway rewrite" } },
      prov,
      now,
    );
    const c = await addFact("hop three");
    const b = await addFact("hop two");
    const a = await addFact("hop one");
    await link(a, ws.id);
    await link(b, a);
    await link(c, b);
    await verify(port, [ws.id, a, b, c], "alice", now);
    return { ws: ws.id, a, b, c };
  }

  it("defaults to one hop, exactly as v4.0 did", async () => {
    const s = await chain();
    const res = await inject(port, ont, "", now, { scope: s.ws });
    expect(res.items.map((i) => i.entity.id)).toEqual([s.a]);
    // No walk stats at depth 1: there is no walk to describe, and adding the field would change
    // every existing caller's output for a feature they did not ask for.
    expect(res.walk).toBeUndefined();
  });

  it("reaches further with depth, nearest first", async () => {
    const s = await chain();
    const res = await inject(port, ont, "", now, { scope: s.ws, depth: 3 });
    // Order is the contract: distance leads the briefing sort. The three share a last_confirmed and
    // their ids DESCEND along the chain (see `chain`), so this sequence is only producible by sorting
    // on distance — the id tiebreak alone would return it reversed.
    expect(res.items.map((i) => i.entity.id)).toEqual([s.a, s.b, s.c]);
    expect(res.walk).toEqual({ depth: 3, nodes: 3, truncated: false });
  });

  // derived_from (v5.8) is deliberately NOT membership: the evidence under a decision is knowledge, so
  // the walk should reach it. This pins both halves of that decision — depth 1 unchanged (a derivation
  // edge joins two records and touches no anchor, so it cannot be followed on the first hop), and the
  // basis arriving at depth 2. If the type were ever marked `membership`, the second case fails.
  it("follows derived_from to a decision's basis, and not before depth 2", async () => {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "queue migration" } },
      prov,
      now,
    );
    // Minted before the decision, so the basis's id SORTS FIRST — the depth-1 assertion below would
    // pass on an id tiebreak if the walk wrongly returned both, so mint order has to fight the claim.
    const basis = await addFact("the queue is at-least-once");
    const { entity: decision } = await commit(
      port,
      ont,
      {
        type: "decision",
        attributes: {
          conclusion: "consumers must be idempotent",
          rationale: "redelivery is expected, not exceptional",
        },
      },
      prov,
      now,
    );
    await link(decision.id, ws.id);
    await commit(
      port,
      ont,
      {
        type: "derived_from",
        attributes: {},
        from: decision.id,
        to: basis,
      },
      prov,
      now,
    );
    await verify(port, [ws.id, basis, decision.id], "alice", now);

    const one = await inject(port, ont, "", now, { scope: ws.id });
    expect(one.items.map((i) => i.entity.id)).toEqual([decision.id]);

    const two = await inject(port, ont, "", now, { scope: ws.id, depth: 2 });
    expect(two.items.map((i) => i.entity.id)).toEqual([decision.id, basis]);
  });

  it("holds a record at its SHORTEST distance, and terminates on a cycle", async () => {
    const s = await chain();
    await link(s.c, s.ws); // c is now 1 hop as well as 3, and the chain is a cycle
    const res = await inject(port, ont, "", now, { scope: s.ws, depth: 3 });
    expect(res.walk?.nodes).toBe(3); // three records, not three plus revisits
    // c is reachable in one hop now, so it must not sort behind b.
    const order = res.items.map((i) => i.entity.id);
    expect(order.indexOf(s.c)).toBeLessThan(order.indexOf(s.b));
  });

  it("does not hand over the author of every neighbour", async () => {
    // v4.0 dropped `authored_by` leaving the ANCHOR. Generalised in v5.7: at depth 2 the old rule
    // walked the hop-1 record's own authored_by edge and delivered its author as knowledge — the
    // roster problem `membership: true` exists to prevent, arriving through an unmarked relation type.
    await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Alice" } },
      prov,
      now,
      { existingId: "alice" },
    );
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "billing" } },
      prov,
      now,
    );
    const fact = await addFact("authored by alice");
    await link(fact, ws.id);
    await verify(port, [ws.id, fact, "alice"], "alice", now);

    const res = await inject(port, ont, "", now, { scope: ws.id, depth: 2 });
    expect(res.items.map((i) => i.entity.id)).toEqual([fact]);
  });

  it("still refuses a roster at the second hop", async () => {
    // `works_on` is membership. A depth-2 walk from a collaboration reaches its members' other work
    // through them, and the members themselves must stay out of the briefing either way.
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "search revamp" } },
      prov,
      now,
    );
    const { entity: person } = await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Kim" } },
      prov,
      now,
    );
    await commit(
      port,
      ont,
      { type: "works_on", attributes: {}, from: person.id, to: ws.id },
      prov,
      now,
    );
    const fact = await addFact("real knowledge about the work");
    await link(fact, ws.id);
    await verify(port, [ws.id, person.id, fact], "alice", now);

    const res = await inject(port, ont, "", now, { scope: ws.id, depth: 2 });
    expect(res.items.map((i) => i.entity.id)).toEqual([fact]);
  });

  it("bounds the walk and says so", async () => {
    // A hub wide enough to exhaust WALK_BUDGET. Without the budget this is one `neighbors` call per
    // node in the corpus — the class of unbounded read docs/SCALE.md recorded five of.
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "wide" } },
      prov,
      now,
    );
    const ids: string[] = [];
    for (let i = 0; i < WALK_BUDGET + 20; i++) {
      const f = await addFact(`spoke ${i}`);
      await link(f, ws.id);
      ids.push(f);
    }
    await verify(port, [ws.id, ...ids], "alice", now);

    const res = await inject(port, ont, "", now, { scope: ws.id, depth: 2 });
    // Every spoke is one hop, so all of them are IN the set — the budget stops the second-hop
    // expansion, not the first-hop collection.
    expect(res.walk?.nodes).toBe(WALK_BUDGET + 20);
    expect(res.walk?.truncated).toBe(true);
    // depth 1 with the same corpus is never truncated: one expansion, one budget unit.
    const shallow = await inject(port, ont, "", now, { scope: ws.id });
    expect(shallow.walk).toBeUndefined();
  });

  it("with a query, a nearer record leads a farther one", async () => {
    const s = await chain();
    const far = await addFact("hop nothing, matches the query");
    await verify(port, [far], "alice", now);
    // All four contain "hop". Unanchored relevance would order them by BM25; the anchor grades them
    // by distance first and lets fusion own the order inside each band.
    const res = await inject(port, ont, "hop", now, { scope: s.ws, depth: 2 });
    const order = res.items.map((i) => i.entity.id);
    expect(order.indexOf(s.a)).toBeLessThan(order.indexOf(s.b));
    expect(order.indexOf(s.b)).toBeLessThan(order.indexOf(far));
    expect(order).toContain(far); // scope prioritizes, it does not imprison
  });
});

describe("inject scoped: a briefing is knowledge, in a defined order", () => {
  /** works_on points person → collaboration, the shape the seed ontology documents. */
  async function member(name: string, ws: string) {
    const { entity } = await commit(
      port,
      ont,
      { type: "person", attributes: { name } },
      prov,
      now,
    );
    await commit(
      port,
      ont,
      { type: "works_on", attributes: {}, from: entity.id, to: ws },
      prov,
      now,
    );
    await verify(port, [entity.id], "alice", now);
    return entity.id;
  }

  async function scene() {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "search relevance" } },
      prov,
      now,
    );
    // Members are created FIRST, so on any backend that returns relations in creation order they
    // would lead the briefing — which is exactly the defect: under a limit the roster crowded the
    // knowledge out entirely.
    const people = [
      await member("Bora", ws.id),
      await member("Alex", ws.id),
      await member("Chen", ws.id),
    ];
    const knowledge = [
      await addFact("redis p99 is 4ms"),
      await addFact("deployment takes 11 minutes"),
    ];
    for (const k of knowledge) await link(k, ws.id);
    await verify(port, [ws.id, ...knowledge], "alice", now);
    return { ws: ws.id, people, knowledge };
  }

  it("excludes members: a roster is not knowledge about the work", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "", now, { scope: s.ws });
    const ids = items.map((i) => i.entity.id);
    expect(ids.sort()).toEqual([...s.knowledge].sort());
    for (const p of s.people) expect(ids).not.toContain(p);
  });

  it("still returns members when the caller asks for that relation by name", async () => {
    // The escape hatch: `scopeRel: 'works_on'` is someone deliberately asking who is on the work.
    // Silently returning nothing there would be worse than the original defect.
    const s = await scene();
    const { items } = await inject(port, ont, "", now, {
      scope: s.ws,
      scopeRel: "works_on",
      scopeDir: "in",
    });
    expect(items.map((i) => i.entity.id).sort()).toEqual([...s.people].sort());
  });

  it("a limit now cuts by the defined order, not by whichever row was written first", async () => {
    const s = await scene();
    const { items } = await inject(port, ont, "", now, {
      scope: s.ws,
      limit: 2,
    });
    // Two slots, and both go to knowledge — this is the assertion that fails on the old behaviour,
    // where the three people were written first and took every slot.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.entity.id).sort()).toEqual(
      [...s.knowledge].sort(),
    );
  });

  it("orders most-recently-confirmed first, with a deterministic tiebreak", async () => {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "ordering" } },
      prov,
      now,
    );
    const older = await addFact("confirmed long ago");
    const newer = await addFact("confirmed recently");
    await link(older, ws.id);
    await link(newer, ws.id);
    // Both dates stay inside fact's 180-day TTL: confirm one too long ago and it reads as stale and
    // is filtered out before ordering can be observed at all.
    await verify(port, [ws.id, older], "alice", "2026-06-01T00:00:00Z");
    await verify(port, [newer], "alice", now);

    const { items } = await inject(port, ont, "", now, { scope: ws.id });
    expect(items.map((i) => i.entity.id)).toEqual([newer, older]);

    // Same order every call — the property that makes four backends agree.
    const again = await inject(port, ont, "", now, { scope: ws.id });
    expect(again.items.map((i) => i.entity.id)).toEqual(
      items.map((i) => i.entity.id),
    );
  });

  it("is driven by the ontology, not by a relation name in core", async () => {
    // A tenant ontology that has marked NEITHER flag gets the members, because nothing declared them
    // to be either a roster edge or a structural type. That is the point of putting both in data: a
    // tenant's own membership relation (assigned_to, member_of) and its own unit type (squad,
    // service) work the same way with no core change.
    //
    // Both have to be cleared, and that is the design rather than an inconvenience: they say
    // different things. `membership` is "this EDGE records who is involved"; `structural` is "this
    // TYPE names a thing rather than asserting one". An org that decides its roster is knowledge has
    // not thereby decided that a bare person record is.
    const unmarked = ont.map((t) =>
      t.name === "works_on"
        ? { ...t, membership: undefined }
        : t.name === "person"
          ? { ...t, structural: undefined }
          : t,
    );
    const s = await scene();
    const { items } = await inject(port, unmarked, "", now, { scope: s.ws });
    expect(items.map((i) => i.entity.id)).toEqual(
      expect.arrayContaining(s.people),
    );
  });

  // The defect: `membership` only skips the roster EDGE, so linking a person with any other relation
  // put them back in the briefing as a record to answer from.
  it("keeps a person out of a briefing even when an unmarked relation reached them", async () => {
    const s = await scene();
    const { entity: outsider } = await commit(
      port,
      ont,
      { type: "person", attributes: { name: "passer-by" } },
      prov,
      now,
    );
    // `relates_to`, not `works_on` — an ordinary link, which is how the roster rule was escapable.
    await link(outsider.id, s.ws);
    await verify(port, [outsider.id], "alice", now);
    const { items } = await inject(port, ont, "", now, { scope: s.ws });
    expect(items.map((i) => i.entity.id)).not.toContain(outsider.id);
  });
});

describe("limit means injectable records, not candidates", () => {
  // The defect this closes was invisible at every scale because the ratio was constant: `limit` went
  // into search(), the verified/freshness filter ran afterwards in core, and a request for 50 came
  // back as 29 whether the corpus held ten thousand records or ten million — while 589,285
  // injectable ones sat unreturned (docs/SCALE.md). Nothing failed; the agent was simply told less
  // than it asked for, with no symptom.
  it("returns the full limit even when most matches are not injectable", async () => {
    // 20 verified, 60 draft, 20 deprecated: 20% injectable, so capping before filtering would
    // return about a fifth of any limit.
    const verified: string[] = [];
    for (let i = 0; i < 20; i++)
      verified.push(await addFact(`quorum drift ${i}`));
    await verify(port, verified, "reviewer", now);
    for (let i = 0; i < 60; i++) await addFact(`quorum drift draft ${i}`);
    const retired: string[] = [];
    for (let i = 0; i < 20; i++)
      retired.push(await addFact(`quorum drift old ${i}`));
    await verify(port, retired, "reviewer", now);
    for (const id of retired) {
      const e = await port.getEntity(id);
      if (e)
        await port.putEntity({
          ...e,
          version: e.version + 1,
          status: "deprecated",
        });
    }

    const out = await inject(port, ont, "quorum", now, { limit: 10 });
    expect(out.items).toHaveLength(10);
    expect(out.items.every((i) => i.effectiveStatus === "verified")).toBe(true);

    // And asking for more than exist is a short answer, not a wrong one.
    const all = await inject(port, ont, "quorum", now, { limit: 50 });
    expect(all.items).toHaveLength(20);
  });

  it("caps the scoped query path instead of materializing every match", async () => {
    // The same call shape that heap-crashed at 10M: scope + query. The assertion here is that the
    // limit reaches the store at all — a scope-anchored query must not become an unbounded read.
    const { entity: work } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "quorum work" } },
      prov,
      now,
    );
    await verify(port, [work.id], "reviewer", now);
    const attached: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = await addFact(`quorum attached ${i}`);
      await link(id, work.id);
      attached.push(id);
    }
    for (let i = 0; i < 30; i++) await addFact(`quorum elsewhere ${i}`);
    await verify(port, attached, "reviewer", now);

    let asked: number | undefined = -1;
    // A Proxy, not `{...port}`: the adapter's methods live on the prototype, so a spread produced an
    // object with no `neighbors` and the failure looked like a core bug.
    const spy = new Proxy(port, {
      get(target, prop) {
        if (prop === "search")
          return (q: Parameters<typeof port.search>[0]) => {
            asked = q.limit;
            return target.search(q);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const out = await inject(spy, ont, "quorum", now, {
      scope: work.id,
      limit: 5,
    });
    expect(asked).not.toBeUndefined();
    expect(asked).toBeGreaterThanOrEqual(5);
    expect(out.items).toHaveLength(5);
    // Scope still leads: the attached records come first, which is what the anchor is for.
    expect(out.items.every((i) => attached.includes(i.entity.id))).toBe(true);
  });
});

describe("inject reports what its limit dropped", () => {
  async function bigScene(n: number) {
    const { entity: ws } = await commit(
      port,
      ont,
      { type: "collaboration", attributes: { title: "long running" } },
      prov,
      now,
    );
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      // Distinct confirm days so the freshness order is unambiguous, all inside fact's 180-day TTL.
      const at = `2026-07-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00Z`;
      const id = await addFact(`finding ${i} about widget${i}`);
      await link(id, ws.id);
      await verify(port, [id], "alice", at);
      ids.push(id);
    }
    await verify(port, [ws.id], "alice", now);
    return { ws: ws.id, ids };
  }

  it("reports omitted so a caller can say 'N of M' instead of slicing silently", async () => {
    const s = await bigScene(12);
    const { items, omitted } = await inject(port, ont, "", now, {
      scope: s.ws,
      limit: 5,
    });
    expect(items).toHaveLength(5);
    expect(omitted).toBe(7);
    expect(items.length + omitted).toBe(12);
  });

  it("reports zero when nothing was dropped", async () => {
    const s = await bigScene(3);
    const { omitted } = await inject(port, ont, "", now, {
      scope: s.ws,
      limit: 50,
    });
    expect(omitted).toBe(0);
  });

  it("a query still reaches knowledge the briefing's limit dropped", async () => {
    // This is what makes a cap honest rather than knowledge loss: the briefing is a window on the
    // work, and the query path searches the whole namespace with scope-linked results merely first.
    const s = await bigScene(12);
    const briefed = await inject(port, ont, "", now, { scope: s.ws, limit: 3 });
    const shown = new Set(briefed.items.map((i) => i.entity.id));
    const dropped = s.ids.filter((id) => !shown.has(id));
    expect(dropped.length).toBe(9);

    // Ask about one of the dropped records by name, keeping the same anchor and an even tighter limit.
    const target = dropped[0];
    const idx = s.ids.indexOf(target);
    const { items } = await inject(port, ont, `widget${idx}`, now, {
      scope: s.ws,
      limit: 1,
    });
    expect(items.map((i) => i.entity.id)).toContain(target);
  });
});

describe("as-of injection", () => {
  const verifiedAt = "2026-07-13T00:00:00Z";
  const retiredAt = "2026-07-20T00:00:00Z";
  const between = "2026-07-15T00:00:00Z";
  const after = "2026-07-25T00:00:00Z";

  it("returns a record that was verified then and is deprecated now", async () => {
    const id = await addFact("quokkatoken was the answer");
    await verify(port, [id], "alice", verifiedAt);
    await deprecate(port, [id], "alice", retiredAt);

    // Today it is excluded, which is correct and is also why the as-of read has to bypass the status
    // push-down: asking the store for verified rows only would filter this record out BEFORE the
    // rewind could restore what it was. The cap-before-filter bug, one clock further back.
    const nowRead = await inject(port, ont, "quokkatoken", after);
    expect(nowRead.items).toEqual([]);

    const then = await inject(port, ont, "quokkatoken", after, {
      asOf: between,
    });
    expect(then.items.map((it) => it.entity.id)).toEqual([id]);
    expect(then.items[0].effectiveStatus).toBe("verified");
    // The REWOUND version is what comes back, so the citation names the version that was current
    // then — an as-of read that cited today's version would be unquotable.
    expect(then.items[0].entity.version).toBe(2);
  });

  it("excludes a record that did not exist yet", async () => {
    const id = await addFact("zqfuture");
    await verify(port, [id], "alice", verifiedAt);
    const before = await inject(port, ont, "zqfuture", after, {
      asOf: "2020-01-01T00:00:00Z",
    });
    expect(before.items).toEqual([]);
  });

  it("judges freshness against asOf, not the wall clock", async () => {
    const id = await addFact("zqfreshness");
    await verify(port, [id], "alice", verifiedAt); // fact TTL = 180 days
    // Long past the TTL now, so a normal read drops it as stale...
    const late = "2027-06-01T00:00:00Z";
    expect((await inject(port, ont, "zqfreshness", late)).items).toEqual([]);
    // ...but it was inside its window then, which is what the question asks.
    const then = await inject(port, ont, "zqfreshness", late, {
      asOf: between,
    });
    expect(then.items.map((it) => it.entity.id)).toEqual([id]);
  });

  it("a record still draft at that instant stays excluded", async () => {
    const id = await addFact("zqdraftthen");
    await verify(port, [id], "alice", retiredAt);
    // Verified on the 20th; as of the 15th it was a draft, so an as-of read must not hand it over
    // merely because it is verified today.
    const then = await inject(port, ont, "zqdraftthen", after, {
      asOf: between,
    });
    expect(then.items).toEqual([]);
    // ...and it IS returned once the clock passes the promotion.
    const later = await inject(port, ont, "zqdraftthen", after, {
      asOf: "2026-07-21T00:00:00Z",
    });
    expect(later.items.map((it) => it.entity.id)).toEqual([id]);
  });
});

describe("hybrid retrieval: the vector half of the Embedder contract", () => {
  // A vocabulary-mismatch corpus. `quatrain` shares no token with the query, so the keyword half
  // cannot reach it at any limit — that is the case measured in docs/RESEARCH.md (Korean queries:
  // bge-m3 8/8, FTS 0/8) reduced to two records.
  const QUERY = "sonnet";
  const NEAR = Float32Array.from([1, 0]);
  const FAR = Float32Array.from([0, 1]);
  /** A lookup embedder, not commit.test.ts's bag-of-words hash: to a word-overlap stub "different
   * vocabulary" IS orthogonality, so it cannot express the one relationship under test. Records are
   * indexed with what this returns at commit time, so the mapping below is the whole semantic claim —
   * the query sits next to the record that shares none of its words. */
  const semantic: Embedder = async (text) =>
    text === QUERY || text.includes("quatrain") ? NEAR : FAR;

  async function corpus() {
    const keyword = await addFact("sonnet form and meter");
    const vectorOnly = await addFactWith("quatrain form and meter", semantic);
    await verify(port, [keyword, vectorOnly], "alice", now);
    return { keyword, vectorOnly };
  }

  it("reaches a record the keyword half cannot, and does not without an embedder", async () => {
    const { keyword, vectorOnly } = await corpus();

    const withoutVectors = await inject(port, ont, QUERY, now);
    expect(withoutVectors.items.map((i) => i.entity.id)).toEqual([keyword]);

    const hybrid = await inject(port, ont, QUERY, now, { embedder: semantic });
    expect(hybrid.items.map((i) => i.entity.id).sort()).toEqual(
      [keyword, vectorOnly].sort(),
    );
  });

  it("does not let a loose keyword hit outrank the vector half's best (v5.6)", async () => {
    // The regression clause 8 introduced and KEYWORD_WEIGHT closes. A four-token query is a
    // disjunction, so the keyword list fills with records sharing one word and ranks them
    // confidently; at equal fusion weight its rank-1 displaced a vector rank-1 the keyword half had
    // never seen, costing 12 points of accuracy@1 over the gold set.
    const LONG = `${QUERY} hovercraft zeppelin monorail`;
    const near: Embedder = async (text) =>
      text === LONG || text.includes("quatrain") ? NEAR : FAR;

    // Order of creation is load-bearing: both records are rank 1 of their own list, so at equal
    // weight the fused scores TIE and the ULID tiebreak decides. Minting the keyword record first
    // makes it win that tie, which is what makes this check fail when the weight is removed. Reverse
    // the two lines and it passes for the wrong reason.
    const oneTermMatch = await addFact("hovercraft ferry winter timetable");
    // Shares no token with the query at all — reachable only through the vector half.
    const vectorOnly = await addFactWith("quatrain enjambment caesura", near);
    await verify(port, [oneTermMatch, vectorOnly], "alice", now);

    const items = (
      await inject(port, ont, LONG, now, { embedder: near })
    ).items.map((i) => i.entity.id);
    expect(items).toContain(oneTermMatch); // the disjunction still reaches it — clause 8
    expect(items[0]).toBe(vectorOnly); // but it does not lead. At weight 1.0 it did
  });

  it("returns the keyword list untouched when the embedder yields nothing", async () => {
    await corpus();
    const expected = (await inject(port, ont, "form", now)).items.map(
      (i) => i.entity.id,
    );
    expect(expected.length).toBeGreaterThan(1); // non-vacuous: an order exists to preserve

    // Unconfigured (SPEC: an unconfigured provider is a FUNCTION returning null, not undefined) and
    // a backend with no `similar` must both be indistinguishable from v5.2.
    const nullEmbedder = await inject(port, ont, "form", now, {
      embedder: async () => null,
    });
    expect(nullEmbedder.items.map((i) => i.entity.id)).toEqual(expected);

    const noVectorBackend = Object.create(port) as SqliteStorage;
    Object.defineProperty(noVectorBackend, "similar", { value: undefined });
    const unsupported = await inject(noVectorBackend, ont, "form", now, {
      embedder: semantic,
    });
    expect(unsupported.items.map((i) => i.entity.id)).toEqual(expected);
  });

  it("does not let a vector hit cross a namespace", async () => {
    // `similar(embedding, k)` takes no ns, so this filter lives in core. Without it the vector half
    // leaks across tenants where the keyword half does not.
    const mine = await addFactWith("quatrain form and meter", semantic);
    await verify(port, [mine], "alice", now);
    const theirs = await addFactWith(
      "quatrain form and meter",
      semantic,
      "tenant-b",
    );
    await verify(port, [theirs], "alice", now, "tenant-b");

    const items = (await inject(port, ont, QUERY, now, { embedder: semantic }))
      .items;
    expect(items.map((i) => i.entity.id)).toEqual([mine]);

    // Non-vacuous: the other tenant's record IS in the vector index and IS the nearest neighbour, so
    // the assertion above is the ns filter working rather than an empty index.
    const neighbours = await port.similar(NEAR, 10);
    expect(neighbours.map((e) => e.id).sort()).toEqual([mine, theirs].sort());
  });

  it("lets a dimension mismatch travel instead of degrading to keyword-only", async () => {
    await corpus();
    // A model change is the realistic cause. Silently answering from the old index, or silently
    // dropping to FTS, both leave a broken vector half nobody is told about.
    await expect(
      inject(port, ont, QUERY, now, {
        embedder: async () => Float32Array.from([1, 0, 0, 0]),
      }),
    ).rejects.toThrow(/dimension changed.*backfill --embeddings --rebuild/s);
  });
});

// An empty answer used to be one word for four situations. The three surfaces then each guessed:
// the CLI explained drafts only, the MCP tool said "no verified knowledge found", the web said
// nothing. Core now says which, so all three say the same thing.
describe("an empty injection says why it is empty", () => {
  it("names drafts awaiting review", async () => {
    await addFact("the pool drains at midnight");
    const res = await inject(port, ont, "pool", now);
    expect(res.items).toEqual([]);
    expect(res.withheld).toEqual({
      draft: 1,
      stale: 0,
      deprecated: 0,
      structural: 0,
      superseded: 0,
    });
  });

  it("names a retired record, which the draft-only version could not", async () => {
    const f = await addFact("we deploy on fridays");
    await verify(port, [f], "admin", now);
    await deprecate(port, [f], "admin", now);
    const res = await inject(port, ont, "fridays", now);
    expect(res.items).toEqual([]);
    expect(res.withheld?.deprecated).toBe(1);
    expect(res.withheld?.draft).toBe(0);
  });

  it("names a stale record rather than implying it was never recorded", async () => {
    const f = await addFact("the gateway retries twice");
    await verify(port, [f], "admin", now);
    // fact TTL = 180 days.
    const res = await inject(port, ont, "gateway", "2027-06-01T00:00:00Z");
    expect(res.items).toEqual([]);
    expect(res.withheld?.stale).toBe(1);
  });

  // The reason that misdirects worst: a verified person matching the query is withheld by TYPE, so a
  // reader told "draft withheld" verifies it and the answer does not improve.
  it("distinguishes a structural match from one awaiting review", async () => {
    const { entity } = await commit(
      port,
      ont,
      { type: "person", attributes: { name: "Mina" } },
      prov,
      now,
    );
    await verify(port, [entity.id], "admin", now);
    const res = await inject(port, ont, "Mina", now);
    expect(res.items).toEqual([]);
    expect(res.withheld).toEqual({
      draft: 0,
      stale: 0,
      deprecated: 0,
      structural: 1,
      superseded: 0,
    });
  });

  it("is absent when the query matched nothing at all — a different answer", async () => {
    const f = await addFact("the pool drains at midnight");
    await verify(port, [f], "admin", now);
    const res = await inject(port, ont, "kubernetes", now);
    expect(res.items).toEqual([]);
    expect(res.withheld).toBeUndefined();
  });

  it("is absent when everything that matched was handed over", async () => {
    const f = await addFact("the pool drains at midnight");
    await verify(port, [f], "admin", now);
    const res = await inject(port, ont, "pool", now);
    expect(res.items).toHaveLength(1);
    expect(res.withheld).toBeUndefined();
  });
});

// The dangerous case, and the one the empty-only version could not reach: a full page of answers with
// the record that actually answers the question filtered out of it. The reader concludes nothing was
// recorded, having been shown proof that the corpus is not silent.
describe("a partial injection says what it held back", () => {
  it("reports a stale record alongside the records it did return", async () => {
    const fresh = await addFact("the pool drains at midnight");
    const stale = await addFact("the pool drains at noon");
    await verify(port, [fresh], "admin", now);
    // Verified long before the read, so only this one is past the 180-day fact TTL.
    await verify(port, [stale], "admin", "2026-01-01T00:00:00Z");
    const res = await inject(port, ont, "pool", now);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].entity.id).toBe(fresh);
    expect(res.withheld?.stale).toBe(1);
  });

  it("does not count the records it injected as withheld", async () => {
    const a = await addFact("the gateway retries twice");
    const b = await addFact("the gateway retries three times");
    await verify(port, [a, b], "admin", now);
    const res = await inject(port, ont, "gateway", now);
    expect(res.items).toHaveLength(2);
    expect(res.withheld).toBeUndefined();
  });

  it("reports drafts held back from an answer that was not empty", async () => {
    const v = await addFact("the gateway retries twice");
    await addFact("the gateway retries three times");
    await verify(port, [v], "admin", now);
    const res = await inject(port, ont, "gateway", now);
    expect(res.items).toHaveLength(1);
    expect(res.withheld?.draft).toBe(1);
  });
});

// A reason computed from today's row is a reason about the wrong record. `--as-of 2020` on a corpus
// created in 2026 answered "1 retired": nothing existed then, and the retirement it named had not
// happened yet.
describe("as-of withheld reasons are about the version that existed then", () => {
  it("says nothing was withheld for an instant before the record existed", async () => {
    const f = await addFact("we deploy on fridays");
    await verify(port, [f], "admin", now);
    await deprecate(port, [f], "admin", now);
    const res = await inject(port, ont, "fridays", now, {
      asOf: "2020-01-01T00:00:00Z",
    });
    expect(res.items).toEqual([]);
    expect(res.withheld).toBeUndefined();
  });

  it("names the status the record actually had then, not the one it has now", async () => {
    const f = await addFact("we deploy on fridays");
    // Still a draft at this instant; verified and retired afterwards.
    const whileDraft = "2026-07-12T00:00:01Z";
    await verify(port, [f], "admin", "2026-07-13T00:00:00Z");
    await deprecate(port, [f], "admin", "2026-07-14T00:00:00Z");
    const res = await inject(port, ont, "fridays", now, { asOf: whileDraft });
    expect(res.items).toEqual([]);
    expect(res.withheld?.draft).toBe(1);
    expect(res.withheld?.deprecated).toBe(0);
  });
});

// The store knew both of these and injection asked neither. `grep conflicts_with src/core/inject.ts`
// found nothing, and `supersedes` was understood by exactly one function in the product
// (checkPersonaSources) — so a persona exported both halves of a reversal as live guiding principles,
// and six queries on the demo corpus handed an agent both sides of a live disagreement as equal facts.
describe("injection knows what a record contradicts and what replaced it", () => {
  /** Two verified facts, and the edge between them. */
  async function pair(
    aText: string,
    bText: string,
    relType: string,
  ): Promise<{ a: string; b: string }> {
    const a = await addFact(aText);
    const b = await addFact(bText);
    await verify(port, [a, b], "admin", now);
    await commit(
      port,
      ont,
      { type: relType, attributes: {}, from: a, to: b },
      prov,
      now,
    );
    return { a, b };
  }

  it("marks both sides of a contradiction and withholds neither", async () => {
    // "Contradictions are surfaced, never auto-resolved" — dropping a side would be the database
    // deciding the winner, and dropping both would delete the disagreement.
    const { a, b } = await pair(
      "the gateway rejects retries within 2s",
      "the gateway accepts retries immediately",
      "conflicts_with",
    );
    const res = await inject(port, ont, "gateway retries", now);
    expect(res.items).toHaveLength(2);
    for (const item of res.items) {
      const other = item.entity.id === a ? b : a;
      expect(item.conflictsWith).toEqual([other]);
    }
    expect(res.withheld).toBeUndefined();
  });

  it("marks a contradiction recorded from either end, since the relation is symmetric", async () => {
    const { a, b } = await pair(
      "freeze on friday",
      "freeze on thursday",
      "conflicts_with",
    );
    // Filed a -> b; b must still learn about it.
    const res = await inject(port, ont, "freeze", now);
    const forB = res.items.find((i) => i.entity.id === b);
    expect(forB?.conflictsWith).toEqual([a]);
  });

  it("is absent on a record with nothing to declare", async () => {
    // "Not disputed" and "we did not look" have to read differently.
    const f = await addFact("the pool drains at midnight");
    await verify(port, [f], "admin", now);
    const res = await inject(port, ont, "pool", now);
    expect(res.items[0].conflictsWith).toBeUndefined();
  });

  it("withholds a superseded record and says which reason it was", async () => {
    // `a supersedes b`, so b is the one no longer current — the direction is the whole correctness of
    // this: read the other way round it would withhold every replacement and serve what they replaced.
    const { a } = await pair(
      "internal calls use HTTP/JSON with an OpenAPI contract",
      "internal calls use gRPC",
      "supersedes",
    );
    const res = await inject(port, ont, "internal calls", now);
    expect(res.items.map((i) => i.entity.id)).toEqual([a]);
    expect(res.withheld?.superseded).toBe(1);
    expect(res.withheld?.stale).toBe(0);
  });

  it("does not let a supersession withhold a record from before it was recorded", async () => {
    // An as-of read rewinds versions; it has to rewind the edges too. Otherwise today's relation graph
    // answers a question about a past instant, and a record that was current then is withheld by a
    // replacement nobody had recorded yet — the same mistake `countWithheld` rewinds versions to avoid.
    const a = await addFact("internal calls use gRPC");
    const b = await addFact("internal calls use HTTP/JSON");
    await verify(port, [a, b], "admin", now);
    const later = "2027-01-01T00:00:00Z";
    await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: b, to: a },
      { ...prov, occurred_at: later },
      later,
    );
    // Asked about today, before the supersession happened: both stand.
    const then = await inject(port, ont, "internal calls", now, { asOf: now });
    expect(then.items.map((i) => i.entity.id).sort()).toEqual([a, b].sort());
    expect(then.withheld?.superseded ?? 0).toBe(0);
    // Asked about after it: the replaced one drops out.
    const after = await inject(port, ont, "internal calls", later, {
      asOf: later,
    });
    expect(after.items.map((i) => i.entity.id)).not.toContain(a);
    expect(after.withheld?.superseded).toBe(1);
  });

  it("reads the same instant the same way, however the caller wrote the offset", async () => {
    // `instantFlag` validates the format and returns it unnormalised, so the offset a person typed
    // reaches core. A lexicographic `<=` then put 2026-08-13T20:00:00-09:00 and 2026-08-14T05:00:00Z —
    // the same moment — on opposite sides of an edge stamped 01:28Z, so one as-of read answered itself
    // two ways: withheld under one spelling, served under the other. `versionAsOf` had it right all
    // along; the edge filter wrote the comparison out again instead of reusing it.
    const a = await addFact("gamma holds");
    const b = await addFact("gamma replaced");
    await verify(port, [a, b], "admin", now);
    const edgeAt = "2026-08-14T01:28:00Z";
    await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: b, to: a },
      { ...prov, occurred_at: edgeAt },
      edgeAt,
    );
    const ids = async (asOf: string) =>
      (await inject(port, ont, "gamma", "2026-08-14T06:00:00Z", { asOf })).items
        .map((i) => i.entity.id)
        .sort();
    expect(await ids("2026-08-13T20:00:00-09:00")).toEqual(
      await ids("2026-08-14T05:00:00Z"),
    );
  });

  it("counts a supersession as withheld, never as a limit truncation", async () => {
    // `omitted` means "your limit cut this many — ask again or raise it", and every front end says so
    // in words. A superseded record is not reachable at any limit, so folding it in made that
    // instruction false; a caller passing no limit at all was told their limit had dropped records.
    await pair(
      "the new limit is 300 rpm",
      "the limit is 1000 rpm",
      "supersedes",
    );
    const res = await inject(port, ont, "rpm limit", now);
    expect(res.items).toHaveLength(1);
    expect(res.omitted).toBe(0);
    expect(res.withheld?.superseded).toBe(1);
  });

  it("does not withhold the record that supersedes", async () => {
    const { a } = await pair(
      "the new limit is 300 rpm",
      "the limit is 1000 rpm",
      "supersedes",
    );
    const res = await inject(port, ont, "rpm limit", now);
    expect(res.items.map((i) => i.entity.id)).toContain(a);
  });

  it("does not let an edge in another namespace mark or withhold a record", async () => {
    // `neighbors` takes no ns, which is why this filter lives in core — the same hole identitySet and
    // downstreamOf each had to close.
    const mine = await addFact("the retry budget is three attempts");
    const theirs = await addFact("the retry budget is one attempt");
    await verify(port, [mine, theirs], "admin", now);
    await commit(
      port,
      ont,
      { type: "supersedes", attributes: {}, from: theirs, to: mine },
      prov,
      now,
      { ns: "other-tenant" },
    );
    const res = await inject(port, ont, "retry budget", now);
    expect(res.items.map((i) => i.entity.id).sort()).toEqual(
      [mine, theirs].sort(),
    );
    expect(res.withheld).toBeUndefined();
  });
});
