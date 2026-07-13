// StoragePort conformance cases — runner-neutral (plain node:assert, no vitest).
// Two consumers: the vitest wrapper in conformance.ts (all adapters' test files)
// and scripts/test-kuzu.mjs, which runs the kuzu adapter in the MAIN process —
// kuzu's native binding crashes vitest's fork IPC, so it cannot run in a pool.
// Keeping the cases here as data means both runners share one contract source.

import assert from "node:assert/strict";
import type { Entity, Relation } from "../core/types.js";
import type { StoragePort } from "./storage.js";

let seq = 0;
function nextId(): string {
  seq += 1;
  return `e${seq.toString().padStart(4, "0")}`;
}

export function makeEntity(over: Partial<Entity> = {}): Entity {
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

export function makeRelation(
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

// JSON-normalizing equality: mirrors vitest toEqual's tolerance for absent-vs-undefined
// keys (deepStrictEqual alone would flag { ns: undefined } vs {}). Cases carry no
// Float32Array, so the JSON round-trip is lossless here.
function eq(actual: unknown, expected: unknown, msg?: string): void {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(actual ?? null)),
    JSON.parse(JSON.stringify(expected ?? null)),
    msg,
  );
}

// Written as a declaration (not an arrow) on purpose: the arrow form sits at
// biome's 80-column boundary, where the darwin and linux binaries disagree on
// CJK-adjacent width math and flip-flop the formatting.
function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

export interface ConformanceCase {
  name: string;
  run(port: StoragePort): Promise<void>;
}

export const conformanceCases: ConformanceCase[] = [
  {
    // (1) putEntity → getEntity round-trip.
    name: "round-trips putEntity → getEntity",
    async run(port) {
      const e = makeEntity();
      await port.putEntity(e);
      eq(await port.getEntity(e.id), e);
    },
  },
  {
    // (2) Re-put the same id → both versions exist; getEntity returns the latest.
    name: "keeps every version on re-put; getEntity returns latest, version selects past",
    async run(port) {
      const id = nextId();
      const v1 = makeEntity({ id, version: 1, attributes: { title: "v1" } });
      const v2 = makeEntity({ id, version: 2, attributes: { title: "v2" } });
      await port.putEntity(v1);
      await port.putEntity(v2);
      eq(await port.getEntity(id), v2);
      eq(await port.getEntity(id, 1), v1);
      eq(await port.getEntity(id, 2), v2);
    },
  },
  {
    // (3) No physical-delete API (checked at the interface level).
    name: "exposes no physical-delete API",
    async run(port) {
      for (const banned of [
        "delete",
        "remove",
        "deleteEntity",
        "removeEntity",
        "purge",
        "drop",
      ]) {
        assert.equal(banned in port, false, `port must not expose ${banned}`);
      }
    },
  },
  {
    // (4) putRelation → neighbors direction filter in/out/both.
    name: "neighbors filters by direction (in/out/both)",
    async run(port) {
      const a = nextId();
      const b = nextId();
      const r = makeRelation(a, b, { type: "cites" });
      await port.putRelation(r);
      eq(await port.neighbors(a, undefined, "out"), [r]);
      eq(await port.neighbors(a, undefined, "in"), []);
      eq(await port.neighbors(b, undefined, "in"), [r]);
      eq(await port.neighbors(b, undefined, "out"), []);
      eq(await port.neighbors(a), [r]);
      eq(await port.neighbors(b), [r]);
    },
  },
  {
    // (5) neighbors relType filter.
    name: "neighbors filters by relType",
    async run(port) {
      const a = nextId();
      const b = nextId();
      const c = nextId();
      const r1 = makeRelation(a, b, { type: "cites" });
      const r2 = makeRelation(a, c, { type: "contradicts" });
      await port.putRelation(r1);
      await port.putRelation(r2);
      eq(await port.neighbors(a, "cites"), [r1]);
      eq(await port.neighbors(a, "contradicts"), [r2]);
      eq((await port.neighbors(a)).slice().sort(byId), [r1, r2].sort(byId));
    },
  },
  {
    // (6) search: FTS match / empty array on no match.
    name: "search matches FTS text and returns [] on no match",
    async run(port) {
      const e = makeEntity({ attributes: { title: "photosynthesis basics" } });
      await port.putEntity(e);
      eq(await port.search({ text: "photosynthesis" }), [e]);
      eq(await port.search({ text: "no-such-token" }), []);
    },
  },
  {
    // (6b) search: prefix match — a token with an attached particle is still found by its
    // stem. The Korean title is a deliberate fixture ("the decision is made with parseArgs"),
    // where "parseArgs" carries a particle suffix; prefix matching must strip it.
    name: "search matches token prefixes (Korean suffix tolerance)",
    async run(port) {
      // Extracted const keeps the line clear of the 80-column boundary, where
      // biome's darwin/linux binaries disagree on CJK width (see byId above).
      const title = "결정은 parseArgs로 한다";
      const e = makeEntity({ attributes: { title } });
      await port.putEntity(e);
      eq(await port.search({ text: "parseArgs" }), [e]);
    },
  },
  {
    // (7) getEntity of an absent id → null.
    name: "getEntity returns null when absent",
    async run(port) {
      assert.equal(await port.getEntity("missing-id"), null);
    },
  },
  {
    // (7b) namespace isolation (PLAN-V2 10.1).
    name: "search isolates by namespace",
    async run(port) {
      const a = makeEntity({ ns: "tenant-a", attributes: { title: "alpha" } });
      const b = makeEntity({ ns: "tenant-b", attributes: { title: "alpha" } });
      await port.putEntity(a);
      await port.putEntity(b);
      eq(await port.search({ text: "alpha", ns: "tenant-a" }), [a]);
      eq(await port.search({ text: "alpha", ns: "tenant-b" }), [b]);
    },
  },
  {
    // (7c) the default (null) namespace sees only default-namespace entities.
    name: "default-namespace search sees only default-namespace entities",
    async run(port) {
      const def = makeEntity({ attributes: { title: "beta" } }); // no ns
      const tenant = makeEntity({
        ns: "tenant-a",
        attributes: { title: "beta" },
      });
      await port.putEntity(def);
      await port.putEntity(tenant);
      eq(await port.search({ text: "beta" }), [def]);
    },
  },
  {
    // (8) similar: optional capability — undefined when unimplemented.
    name: "exposes similar as optional capability (undefined or function)",
    async run(port) {
      const cap = port.similar;
      assert.equal(cap === undefined || typeof cap === "function", true);
    },
  },
];
