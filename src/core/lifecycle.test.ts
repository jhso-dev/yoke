// lifecycle tests — data is prepared through the real SqliteStorage(:memory:) + commit gate.
// verify version bump + history preservation / TTL-expired stale / no ttl = unlimited / deprecate / unknown-id error.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import {
  deprecate,
  downstreamOf,
  effectiveStatus,
  isFresh,
  staleEntities,
  verify,
  versionAsOf,
} from "./lifecycle.js";
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
    // History preserved: v1, which was a draft, is still queryable.
    const v1 = await port.getEntity(id, 1);
    expect(v1?.status).toBe("draft");
    // Latest is the verified v2.
    expect((await port.getEntity(id))?.status).toBe("verified");
  });

  it("effectiveStatus is 'stale' when verified fact exceeds its TTL", async () => {
    const id = await addFact("stale-able");
    await verify(port, [id], "alice", now); // fact TTL = 180 days
    const e = await port.getEntity(id);
    if (!e) throw new Error("missing");

    // After 179 days: fresh.
    expect(effectiveStatus(e, ont, "2027-01-07T00:00:00Z")).toBe("verified");
    // After 181 days: stale (the stored status stays verified).
    expect(isFresh(e, ont, "2027-01-10T00:00:00Z")).toBe(false);
    expect(effectiveStatus(e, ont, "2027-01-10T00:00:00Z")).toBe("stale");
    expect(e.status).toBe("verified");
  });

  it("type without ttl_days is fresh forever", async () => {
    const { entity } = await commit(
      port,
      ont,
      {
        type: "term",
        attributes: {
          title: "grace window",
          statement: "the days a late adjustment is still accepted",
        },
      },
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

  // SPEC "Batch point reads": verify/deprecate "refuse the whole batch". Validating inside the write
  // loop promotes the ids ordered BEFORE the unknown one, then throws — this test is what catches it.
  it("refuses the whole batch: an id before the unknown one is not written", async () => {
    const id = await addFact("survives the refused batch");
    await expect(verify(port, [id, "nope"], "alice", now)).rejects.toThrow(
      /nope/,
    );
    const after = await port.getEntity(id);
    expect(after?.status).toBe("draft");
    expect(after?.version).toBe(1);
  });
});

describe("versionAsOf", () => {
  it("returns the version that was current then, not the latest", async () => {
    const id = await addFact("the answer");
    const verifiedAt = "2026-07-13T00:00:00Z";
    const retiredAt = "2026-07-20T00:00:00Z";
    await verify(port, [id], "alice", verifiedAt);
    await deprecate(port, [id], "alice", retiredAt);

    // This is the whole point: today it is deprecated, and a question about the 15th must not be
    // answered with today's status. Reading the latest row would say "deprecated" and be wrong.
    expect((await port.getEntity(id))?.status).toBe("deprecated");
    const then = await versionAsOf(port, id, "2026-07-15T00:00:00Z");
    expect(then?.status).toBe("verified");
    expect(then?.version).toBe(2);
    // At the boundary the transition has happened — `<=`, not `<`.
    expect((await versionAsOf(port, id, retiredAt))?.status).toBe("deprecated");
  });

  it("returns null before the record existed", async () => {
    const id = await addFact("later knowledge");
    expect(await versionAsOf(port, id, "2020-01-01T00:00:00Z")).toBeNull();
  });

  it("walks getEntity when the backend has no listHistory extension", async () => {
    const id = await addFact("portable");
    await verify(port, [id], "alice", "2026-07-13T00:00:00Z");
    // A Proxy rather than a spread: spreading loses the prototype methods, and `listHistory` has to
    // be genuinely ABSENT for this to test the fallback rather than the extension.
    const bare = new Proxy(port, {
      get: (t, p, r) =>
        p === "listHistory" ? undefined : Reflect.get(t, p, r),
      has: (t, p) => (p === "listHistory" ? false : Reflect.has(t, p)),
    }) as unknown as SqliteStorage;
    expect((await versionAsOf(bare, id, "2026-07-12T12:00:00Z"))?.version).toBe(
      1,
    );
    expect((await versionAsOf(bare, id, "2026-07-14T00:00:00Z"))?.version).toBe(
      2,
    );
  });
});

describe("staleEntities", () => {
  const aged = "2027-01-10T00:00:00Z"; // past fact's 180-day TTL

  it("finds verified records past their TTL and leaves fresh ones alone", async () => {
    const old = await addFact("aged out");
    const fresh = await addFact("still good");
    await verify(port, [old], "alice", now);
    await verify(port, [fresh], "alice", "2026-12-20T00:00:00Z");
    // A draft is not stale — it was never verified, so it belongs in the other queue.
    await addFact("never verified");

    const r = await staleEntities(port, ont, aged);
    expect(r.items.map((e) => e.id)).toEqual([old]);
    expect(r.next).toBeNull();
    // Only the two VERIFIED rows were examined; the draft never entered the walk.
    expect(r.scanned).toBe(2);
  });

  it("a type with no ttl_days never goes stale", async () => {
    const { entity } = await commit(
      port,
      ont,
      {
        type: "term",
        attributes: {
          title: "grace window",
          statement: "the days a late adjustment is still accepted",
        },
      },
      prov,
      now,
    );
    await verify(port, [entity.id], "alice", now);
    expect(
      (await staleEntities(port, ont, "2099-01-01T00:00:00Z")).items,
    ).toEqual([]);
  });

  it("limit cuts the queue and next resumes the SCAN, so paging loses nothing", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addFact(`aged ${i}`));
    await verify(port, ids, "alice", now);

    const first = await staleEntities(port, ont, aged, { limit: 2 });
    expect(first.items.length).toBe(2);
    expect(first.next).not.toBeNull();
    // The cursor is the last row EXAMINED. Paging from the last hit would be the same value here
    // (every row is stale), so the case that distinguishes them is the mixed one below.
    const rest = await staleEntities(port, ont, aged, {
      after: first.next ?? undefined,
    });
    // Union of the pages is every stale record, with no duplicate and nothing skipped.
    expect([...first.items, ...rest.items].map((e) => e.id).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("next is the row examined, so a stopped page resumes exactly where it stopped", async () => {
    // The walk is `ORDER BY id` and ULIDs are only creation-ordered to the millisecond, so which of
    // these sorts first is not knowable from the order they were written — derive it rather than
    // assume it, or this passes or fails on how fast the machine is.
    const written = [await addFact("stale a"), await addFact("stale b")];
    await verify(port, written, "alice", now);
    const [first, second] = [...written].sort();

    const page = await staleEntities(port, ont, aged, { limit: 1 });
    expect(page.items.map((e) => e.id)).toEqual([first]);
    // The cursor is the row it stopped ON, not the row after it — that is what makes resuming lose
    // nothing when the stop lands mid-page with fresh rows still unexamined behind it.
    expect(page.next).toBe(first);
    const next = await staleEntities(port, ont, aged, {
      after: page.next ?? undefined,
    });
    expect(next.items.map((e) => e.id)).toEqual([second]);
  });

  it("type narrows the walk", async () => {
    const f = await addFact("aged fact");
    const { entity: t } = await commit(
      port,
      ont,
      {
        type: "term",
        attributes: {
          title: "grace window",
          statement: "the days a late adjustment is still accepted",
        },
      },
      prov,
      now,
    );
    await verify(port, [f, t.id], "alice", now);
    const r = await staleEntities(port, ont, aged, { type: "fact" });
    expect(r.items.map((e) => e.id)).toEqual([f]);
    expect(r.scanned).toBe(1);
  });
});

// downstreamOf (v5.8) — retiring a record is not a repair unless what rests on it can be found.
// SPEC "Derivation". One incoming `derived_from` hop, namespace-filtered, entities not ids.
describe("downstreamOf", () => {
  /** from derives_from to, filed through the gate like any other relation. */
  async function derive(from: string, to: string, ns?: string) {
    await commit(
      port,
      ont,
      { type: "derived_from", attributes: {}, from, to },
      prov,
      now,
      { ns },
    );
  }

  it("finds the records that declared they rest on a retired one, and not the reverse", async () => {
    const basis = await addFact("postgres is the primary store");
    const dependent = await addFact("the migration plan assumes postgres");
    const unrelated = await addFact("the office wifi password rotates");
    await derive(dependent, basis);

    const down = await downstreamOf(port, [basis]);
    expect(down.map((e) => e.id)).toEqual([dependent]);
    // Direction matters: nothing rests on the dependent, and the edge must not be followed backwards.
    expect(await downstreamOf(port, [dependent])).toEqual([]);
    expect(await downstreamOf(port, [unrelated])).toEqual([]);
  });

  it("deduplicates across several retired ids and never reports a record as its own downstream", async () => {
    const a = await addFact("fact a");
    const b = await addFact("fact b");
    const dependent = await addFact("rests on both");
    await derive(dependent, a);
    await derive(dependent, b);
    // A hand-filed self-edge reaches storage like any other relation (the front tier refuses to make one).
    await derive(a, a);

    expect((await downstreamOf(port, [a, b])).map((e) => e.id)).toEqual([
      dependent,
    ]);
  });

  it("does not cross a namespace, since neighbors takes no ns", async () => {
    const basis = await addFact("shared basis");
    const dependent = await addFact("tenant dependent");
    await derive(dependent, basis, "acme");

    expect(await downstreamOf(port, [basis])).toEqual([]);
    expect(
      (await downstreamOf(port, [basis], "acme")).map((e) => e.id),
    ).toEqual([dependent]);
  });
});

// `link` prints an id and the word `draft`, so the next thing tried is `verify <that id>`. The answer
// was "cannot transition unknown entity" — the store denying a row it was holding.
describe("an edge id is refused as an edge, not as a stranger", () => {
  it("names the relation and why promotion does not apply", async () => {
    const a = await addFact("one end");
    const b = await addFact("the other end");
    const { entity: edge } = await commit(
      port,
      ont,
      { type: "relates_to", attributes: {}, from: a, to: b },
      prov,
      now,
    );
    await expect(verify(port, [edge.id], "admin", now)).rejects.toThrow(
      /is a relation, and relations are not promoted/,
    );
  });

  it("still says unknown for an id that is neither", async () => {
    await expect(
      verify(port, ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"], "admin", now),
    ).rejects.toThrow(/unknown entity/);
  });
});
