// StoragePort conformance cases — runner-neutral (plain node:assert, no vitest).
// Two consumers: the vitest wrapper in conformance.ts (all adapters' test files)
// and scripts/test-kuzu.mjs, which runs the kuzu adapter in the MAIN process —
// kuzu's native binding crashes vitest's fork IPC, so it cannot run in a pool.
// Keeping the cases here as data means both runners share one contract source.

import assert from "node:assert/strict";
import type { Entity, Relation } from "../core/types.js";
import { DEFAULT_SEARCH_LIMIT, type StoragePort } from "./storage.js";

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
    ...(over.ns != null ? { ns: over.ns } : {}),
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
    // (6c) search: multi-word queries are AND-of-terms in any order — NOT a strict
    // phrase. "slack rate" must find "slack connector retries rate limits" (found in
    // live MCP verification: the original whole-query phrase semantics silently
    // missed any multi-word query whose terms weren't consecutive in the text).
    // Note: prefix matching is character-level — "retry" does NOT match "retries"
    // (y vs i); stemming is out of scope. Prefix tolerance itself is case (6b).
    name: "search treats multi-word queries as AND of prefix terms, any order",
    async run(port) {
      const e = makeEntity({
        attributes: { title: "slack connector retries rate limits" },
      });
      await port.putEntity(e);
      eq(await port.search({ text: "slack rate" }), [e]); // non-consecutive terms
      eq(await port.search({ text: "retries slack" }), [e]); // reversed order
      eq(await port.search({ text: "slack missingword" }), []); // AND, not OR
    },
  },
  {
    // (6d) search returns the BEST match first, not the first-stored match. Before this, sqlite
    // returned FTS5's rowid order and kuzu/qdrant sliced whatever order their scan produced, so
    // `limit` silently meant "an arbitrary N" — measured at 1M rows, the top 50 by insertion order
    // and the top 50 by relevance shared ONE record (docs/SCALE.md).
    //
    // Asserted on something every sane ranker agrees about rather than on an exact ordering, since
    // FTS5's bm25 and core's are not required to produce identical scores: the term is rare in the
    // candidate set, and the record that is ABOUT it beats the one that merely mentions it among
    // fifty other words. Both the stored order and the reverse of the expected order are exercised,
    // so the case cannot pass by accident of insertion sequence.
    name: "search returns the best match first, not the first stored",
    async run(port) {
      // Nonsense filler on purpose. The first draft used "alpha beta gamma …", and "beta" is what
      // case 7c searches for — so this case silently broke that one, but only under the kuzu runner,
      // which shares ONE database across cases (see the header). Every token a case introduces has
      // to be unique to it.
      const filler = "zqfill1 zqfill2 zqfill3 zqfill4 zqfill5 zqfill6 zqfill7";
      // Stored FIRST and deliberately the worse match: one mention, buried in filler.
      const mentions = makeEntity({
        attributes: { title: `${filler} tapir ${filler}` },
      });
      // Stored SECOND and the better match: short, and about the term.
      const about = makeEntity({ attributes: { title: "tapir tapir" } });
      await port.putEntity(mentions);
      await port.putEntity(about);

      const hits = await port.search({ text: "tapir" });
      assert.equal(hits.length, 2, "both records match the term");
      assert.equal(
        hits[0].id,
        about.id,
        "the record about the term must outrank the one that mentions it",
      );

      // And the limit cuts from the TOP. This is the clause injection depends on: a capped search
      // must hand back the best k, because the caller filters after and cannot recover what the
      // cap dropped.
      const one = await port.search({ text: "tapir", limit: 1 });
      assert.equal(one.length, 1);
      assert.equal(one[0].id, about.id, "limit 1 must return the best match");
    },
  },
  {
    // (6e) search is bounded even when the caller names no limit. A resource bound, not a policy
    // cap: at 10M entities the unbounded call materialized ten million row objects and the process
    // died of heap exhaustion (docs/SCALE.md). Asserted by count rather than by timing, so it holds
    // on every backend and in CI.
    name: "search is bounded when no limit is given",
    async run(port) {
      // A type of its own, so the thousand rows this case needs cannot reach another case's
      // type-filtered assertion — the shared-database rule again.
      const type = "capybara-bound";
      const n = DEFAULT_SEARCH_LIMIT + 5;
      for (let i = 0; i < n; i++)
        await port.putEntity(
          makeEntity({ type, attributes: { title: `capybara sighting ${i}` } }),
        );
      const all = await port.search({ text: "capybara" });
      assert.equal(
        all.length,
        DEFAULT_SEARCH_LIMIT,
        "an omitted limit must apply DEFAULT_SEARCH_LIMIT, not return every match",
      );
      // Enumeration keeps the OPPOSITE default on purpose — a cursor walk is driven by its caller.
      const listed = await port.listEntities({ type });
      assert.equal(
        listed.items.length,
        n,
        "listEntities must stay unbounded when no limit is given",
      );
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
  // (9) Enumeration (v5.0). Enumeration is the one method that can return the whole database, so
  // every clause of its contract is pinned here. Note each case scopes its assertions to a
  // case-unique type and/or ns: the kuzu runner shares ONE database across all cases, so a case
  // that asserted on an unfiltered listing would pass under vitest and fail there.
  {
    // (9a) latest version only, and the type/status filters compose.
    name: "listEntities returns latest versions only, filtered by type and status",
    async run(port) {
      const a = makeEntity({ type: "listE1", status: "draft" });
      await port.putEntity(a);
      await port.putEntity({ ...a, version: 2, status: "verified" });
      const b = makeEntity({ type: "listE1", status: "draft" });
      await port.putEntity(b);
      await port.putEntity(makeEntity({ type: "listE1-other" }));

      const all = await port.listEntities({ type: "listE1" });
      eq(all.items.map((e) => e.id).sort(), [a.id, b.id].sort());
      eq(
        all.items.map((e) => e.version),
        all.items.map((e) => (e.id === a.id ? 2 : 1)),
        "only the max-version row of each id is enumerated",
      );
      eq(all.next, null, "a complete listing has no next cursor");

      const verified = await port.listEntities({
        type: "listE1",
        status: "verified",
      });
      eq(
        verified.items.map((e) => e.id),
        [a.id],
      );
    },
  },
  {
    // (9b) namespace isolation for entities.
    name: "listEntities isolates by namespace",
    async run(port) {
      const inA = makeEntity({ type: "listE2", ns: "leak-e-a" });
      const inB = makeEntity({ type: "listE2", ns: "leak-e-b" });
      const inDefault = makeEntity({ type: "listE2" });
      for (const e of [inA, inB, inDefault]) await port.putEntity(e);

      const a = await port.listEntities({ type: "listE2", ns: "leak-e-a" });
      eq(
        a.items.map((e) => e.id),
        [inA.id],
        "a tenant listing must not include another tenant's rows",
      );
      const def = await port.listEntities({ type: "listE2" });
      eq(
        def.items.map((e) => e.id),
        [inDefault.id],
        "the default namespace is not a wildcard over tenants",
      );
    },
  },
  {
    // (9c) keyset paging: no gaps, no duplicates, and `next` tells the truth.
    name: "listEntities paginates by keyset cursor without gaps or duplicates",
    async run(port) {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const e = makeEntity({ type: "listE3" });
        await port.putEntity(e);
        ids.push(e.id);
      }
      ids.sort();

      const first = await port.listEntities({ type: "listE3", limit: 2 });
      eq(
        first.items.map((e) => e.id),
        ids.slice(0, 2),
      );
      assert.equal(first.next, ids[1], "next is the last id of this page");

      const second = await port.listEntities({
        type: "listE3",
        limit: 2,
        after: first.next ?? undefined,
      });
      eq(
        second.items.map((e) => e.id),
        ids.slice(2),
      );
      eq(second.next, null, "next is null once the rows run out");

      // Exactly-at-limit must NOT claim a next page (the over-read-by-one contract).
      const exact = await port.listEntities({ type: "listE3", limit: 3 });
      eq(exact.items.length, 3);
      eq(exact.next, null, "next is null when limit exactly consumes the rows");
    },
  },
  {
    // (9d) relations: latest version only, filtered by relation type.
    name: "listRelations returns latest versions only, filtered by type",
    async run(port) {
      const from = makeEntity();
      const to = makeEntity();
      await port.putEntity(from);
      await port.putEntity(to);
      const r = makeRelation(from.id, to.id, { type: "listR1" });
      await port.putRelation(r);
      await port.putRelation({ ...r, version: 2, status: "verified" });
      await port.putRelation(
        makeRelation(from.id, to.id, { type: "listR1-other" }),
      );

      const got = await port.listRelations({ type: "listR1" });
      eq(
        got.items.map((x) => x.id),
        [r.id],
      );
      eq(got.items[0].version, 2);
      eq(got.items[0].from, from.id);
      eq(got.items[0].to, to.id);
    },
  },
  {
    // (9e) namespace isolation for relations — the case that would have caught the shipped
    // cross-tenant leak in the conflicts view (listRelationsByType had no ns parameter).
    name: "listRelations isolates by namespace",
    async run(port) {
      const from = makeEntity();
      const to = makeEntity();
      await port.putEntity(from);
      await port.putEntity(to);
      const inA = makeRelation(from.id, to.id, {
        type: "listR2",
        ns: "leak-r-a",
      });
      const inB = makeRelation(from.id, to.id, {
        type: "listR2",
        ns: "leak-r-b",
      });
      await port.putRelation(inA);
      await port.putRelation(inB);

      const a = await port.listRelations({ type: "listR2", ns: "leak-r-a" });
      eq(
        a.items.map((x) => x.id),
        [inA.id],
      );
      const def = await port.listRelations({ type: "listR2" });
      eq(def.items, [], "no tenant relation leaks into the default namespace");
    },
  },
  {
    // (9f) relations page by the same cursor rules as entities.
    name: "listRelations paginates by keyset cursor",
    async run(port) {
      const from = makeEntity();
      const to = makeEntity();
      await port.putEntity(from);
      await port.putEntity(to);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = makeRelation(from.id, to.id, { type: "listR3" });
        await port.putRelation(r);
        ids.push(r.id);
      }
      ids.sort();

      const first = await port.listRelations({ type: "listR3", limit: 2 });
      eq(
        first.items.map((x) => x.id),
        ids.slice(0, 2),
      );
      assert.equal(first.next, ids[1]);
      const second = await port.listRelations({
        type: "listR3",
        limit: 2,
        after: first.next ?? undefined,
      });
      eq(
        second.items.map((x) => x.id),
        ids.slice(2),
      );
      eq(second.next, null);
    },
  },
];
