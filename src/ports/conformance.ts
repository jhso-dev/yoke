// StoragePort conformance suite — a test factory that adapter tests invoke.
// It uses vitest to verify that any backend honors the same contract.
// The test fixture builders live only here (in the test code).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entity, Relation } from "../core/types.js";
import type { StoragePort } from "./storage.js";

let seq = 0;
function nextId(): string {
  seq += 1;
  return `e${seq.toString().padStart(4, "0")}`;
}

function makeEntity(over: Partial<Entity> = {}): Entity {
  return {
    id: over.id ?? nextId(),
    type: over.type ?? "note",
    attributes: over.attributes ?? { title: "hello world" },
    status: over.status ?? "draft",
    version: over.version ?? 1,
    last_confirmed: over.last_confirmed ?? "2026-01-01T00:00:00Z",
    provenance: over.provenance ?? {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
    ...(over.embedding ? { embedding: over.embedding } : {}),
    ...(over.ns != null ? { ns: over.ns } : {}),
  };
}

function makeRelation(
  from: string,
  to: string,
  over: Partial<Relation> = {},
): Relation {
  return {
    id: over.id ?? nextId(),
    type: over.type ?? "relates_to",
    attributes: over.attributes ?? {},
    from,
    to,
    status: over.status ?? "draft",
    version: over.version ?? 1,
    last_confirmed: over.last_confirmed ?? "2026-01-01T00:00:00Z",
    provenance: over.provenance ?? {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };
}

export function describeStoragePort(
  name: string,
  make: () => Promise<StoragePort>,
): void {
  describe(`StoragePort conformance: ${name}`, () => {
    let port: StoragePort;

    beforeEach(async () => {
      port = await make();
      await port.init();
    });
    afterEach(() => {
      port.close();
    });

    // (1) putEntity → getEntity round-trip.
    it("round-trips putEntity → getEntity", async () => {
      const e = makeEntity();
      await port.putEntity(e);
      expect(await port.getEntity(e.id)).toEqual(e);
    });

    // (2) Re-put the same id → both versions exist; getEntity returns the latest, version selects the past.
    it("keeps every version on re-put; getEntity returns latest, version selects past", async () => {
      const id = nextId();
      const v1 = makeEntity({ id, version: 1, attributes: { title: "v1" } });
      const v2 = makeEntity({ id, version: 2, attributes: { title: "v2" } });
      await port.putEntity(v1);
      await port.putEntity(v2);
      expect(await port.getEntity(id)).toEqual(v2);
      expect(await port.getEntity(id, 1)).toEqual(v1);
      expect(await port.getEntity(id, 2)).toEqual(v2);
    });

    // (3) No physical-delete API (checked at the interface level).
    it("exposes no physical-delete API", () => {
      for (const banned of [
        "delete",
        "remove",
        "deleteEntity",
        "removeEntity",
        "purge",
        "drop",
      ]) {
        expect(banned in port).toBe(false);
      }
    });

    // (4) putRelation → neighbors direction filter in/out/both.
    it("neighbors filters by direction (in/out/both)", async () => {
      const a = nextId();
      const b = nextId();
      const r = makeRelation(a, b, { type: "cites" });
      await port.putRelation(r);
      expect(await port.neighbors(a, undefined, "out")).toEqual([r]);
      expect(await port.neighbors(a, undefined, "in")).toEqual([]);
      expect(await port.neighbors(b, undefined, "in")).toEqual([r]);
      expect(await port.neighbors(b, undefined, "out")).toEqual([]);
      expect(await port.neighbors(a)).toEqual([r]);
      expect(await port.neighbors(b)).toEqual([r]);
    });

    // (5) neighbors relType filter.
    it("neighbors filters by relType", async () => {
      const a = nextId();
      const b = nextId();
      const c = nextId();
      const r1 = makeRelation(a, b, { type: "cites" });
      const r2 = makeRelation(a, c, { type: "contradicts" });
      await port.putRelation(r1);
      await port.putRelation(r2);
      expect(await port.neighbors(a, "cites")).toEqual([r1]);
      expect(await port.neighbors(a, "contradicts")).toEqual([r2]);
      expect(await port.neighbors(a)).toEqual(expect.arrayContaining([r1, r2]));
    });

    // (6) search: FTS match / empty array on no match.
    it("search matches FTS text and returns [] on no match", async () => {
      const e = makeEntity({ attributes: { title: "photosynthesis basics" } });
      await port.putEntity(e);
      expect(await port.search({ text: "photosynthesis" })).toEqual([e]);
      expect(await port.search({ text: "no-such-token" })).toEqual([]);
    });

    // (6b) search: prefix match — a token with an attached particle is still found by its stem.
    // The Korean title below is a deliberate fixture ("the decision is made with parseArgs"), in which
    // "parseArgs" is followed by a particle. It asserts that the FTS prefix match strips that suffix.
    it("search matches token prefixes (Korean suffix tolerance)", async () => {
      const e = makeEntity({
        attributes: { title: "결정은 parseArgs로 한다" },
      });
      await port.putEntity(e);
      expect(await port.search({ text: "parseArgs" })).toEqual([e]);
    });

    // (7) getEntity of an absent id → null.
    it("getEntity returns null when absent", async () => {
      expect(await port.getEntity("missing-id")).toBeNull();
    });

    // (7b) namespace isolation (PLAN-V2 10.1): entities written under one namespace are invisible
    // to a search scoped to a different namespace.
    it("search isolates by namespace", async () => {
      const a = makeEntity({ ns: "tenant-a", attributes: { title: "alpha" } });
      const b = makeEntity({ ns: "tenant-b", attributes: { title: "alpha" } });
      await port.putEntity(a);
      await port.putEntity(b);
      expect(await port.search({ text: "alpha", ns: "tenant-a" })).toEqual([a]);
      expect(await port.search({ text: "alpha", ns: "tenant-b" })).toEqual([b]);
    });

    // (7c) the default (null) namespace sees only default-namespace entities.
    it("default-namespace search sees only default-namespace entities", async () => {
      const def = makeEntity({ attributes: { title: "beta" } }); // no ns
      const tenant = makeEntity({
        ns: "tenant-a",
        attributes: { title: "beta" },
      });
      await port.putEntity(def);
      await port.putEntity(tenant);
      expect(await port.search({ text: "beta" })).toEqual([def]);
    });

    // (8) similar: optional capability — undefined when unimplemented.
    it("exposes similar as optional capability (undefined or function)", () => {
      const cap = port.similar;
      expect(cap === undefined || typeof cap === "function").toBe(true);
    });
  });
}
