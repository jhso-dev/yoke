// backfillEmbeddings — the repair for a vector index that is missing rows.
//
// Coverage was a function of which interface wrote the record: `.mcp.json` configures the embedder for
// the MCP server's process only, so `yoke add` and the web tier stored knowledge with no vector at all
// (measured at 1 of 3 entities in this repo's own database). These tests pin the properties that make
// the repair safe to run: it writes no version, it is idempotent, it is resumable, and it never turns
// an embedding problem into a data problem.

import assert from "node:assert/strict";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import {
  backfillAuthorship,
  backfillEmbeddings,
  backfillOccurredAt,
} from "./backfill.js";
import { commit } from "./commit.js";
import { type Embedder, serializeText } from "./embedding.js";
import { versionAsOf } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const ont = seedOntology();
const now = "2026-08-03T00:00:00Z";
const prov: Provenance = { actor: "tester", origin: "cli", occurred_at: now };

/** Deterministic and content-dependent: the same text always gives the same vector, and two different
 * texts differ. Enough to assert "the right text was embedded" without a provider. */
const stub =
  (dim = 4): Embedder =>
  async (text: string) => {
    const v = new Float32Array(dim);
    for (let i = 0; i < text.length; i++)
      v[i % dim] += text.charCodeAt(i) / 1e4;
    return v;
  };

/** No provider configured — this is what `makeFetchEmbedder({})` returns, and the reason a row can
 * legitimately have no vector. */
const noProvider: Embedder = async () => null;

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

/** Commit WITHOUT an embedder — the exact state this repair exists for. */
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

/** Rows in the vector index. Read through the shadow table so it needs no sqlite-vec query. */
function vectorRows(): number {
  const db = (
    port as unknown as {
      db: { prepare(s: string): { get(): { c: number } } };
    }
  ).db;
  try {
    return db.prepare("SELECT count(*) c FROM entity_vec_rowids").get().c;
  } catch {
    return 0;
  }
}

describe("backfillEmbeddings", () => {
  it("indexes rows committed without a provider, and writes no version", async () => {
    const a = await addFact("the cache warms on boot");
    const b = await addFact("staging trails production by an hour");
    // The starting state: knowledge complete, index empty.
    expect(vectorRows()).toBe(0);
    expect((await port.getEntity(a))?.version).toBe(1);

    const r = await backfillEmbeddings(port, { embedder: stub() });

    expect(r.embedded).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.next).toBeNull();
    expect(vectorRows()).toBe(2);
    // Still v1: a vector is a derived index, so repairing it must not create a version — otherwise
    // every citation already emitted for these records would be stale (SPEC "The vector index").
    expect((await port.getEntity(a))?.version).toBe(1);
    expect((await port.getEntity(b))?.version).toBe(1);
  });

  it("embeds the SAME text the gate does", async () => {
    // If these expressions ever diverge, a backfilled vector lands somewhere else than one written at
    // commit time and duplicate detection starts comparing across two representations.
    const embedder = stub();
    const id = await addFact("tokens rotate hourly");
    await backfillEmbeddings(port, { embedder });

    const e = await port.getEntity(id);
    assert(e);
    const expected = await embedder(
      serializeText(e.type, JSON.stringify(e.attributes)),
    );
    assert(expected);
    const hits = await port.similar(expected, 5);
    expect(hits.find((h) => h.id === id)?.embedding).toEqual(expected);
  });

  it("counts a dead provider as skipped and does not fail", async () => {
    await addFact("one");
    await addFact("two");
    const r = await backfillEmbeddings(port, { embedder: noProvider });
    // An embedding problem must never become a data problem — the same principle the gate applies.
    expect(r).toEqual({ scanned: 2, embedded: 0, skipped: 2, next: null });
    expect(vectorRows()).toBe(0);
  });

  it("reports zeros on a backend with no vector support", async () => {
    await addFact("vectorless-backend");
    // A Proxy, not a spread: spreading loses the prototype methods, and `putEmbedding` has to be
    // genuinely ABSENT for this to exercise the feature-detect.
    const bare = new Proxy(port, {
      get: (t, p, r) =>
        p === "putEmbedding" ? undefined : Reflect.get(t, p, r),
      has: (t, p) => (p === "putEmbedding" ? false : Reflect.has(t, p)),
    }) as unknown as SqliteStorage;
    const r = await backfillEmbeddings(bare, { embedder: stub() });
    // Doing nothing is the honest answer: a repair that cannot apply is not an error.
    expect(r).toEqual({ scanned: 0, embedded: 0, skipped: 0, next: null });
  });

  it("is idempotent — a second run adds no vectors", async () => {
    await addFact("alpha");
    await addFact("bravo");
    const first = await backfillEmbeddings(port, { embedder: stub() });
    const second = await backfillEmbeddings(port, { embedder: stub() });
    expect(second.embedded).toBe(first.embedded);
    // putEmbedding is keyed by id (delete+insert), which is what makes re-embedding every reached row
    // safe rather than duplicative — necessary because `getEntity` cannot say which rows are covered.
    expect(vectorRows()).toBe(2);
  });

  it("limit stops it and next resumes, covering everything exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await addFact(`row ${i}`));

    const first = await backfillEmbeddings(port, {
      embedder: stub(),
      limit: 2,
    });
    expect(first.embedded).toBe(2);
    expect(first.next).not.toBeNull();

    const rest = await backfillEmbeddings(port, {
      embedder: stub(),
      after: first.next ?? undefined,
    });
    expect(first.embedded + rest.embedded).toBe(ids.length);
    expect(vectorRows()).toBe(ids.length);
  });

  it("rebuild drops the index ONCE, not per row", async () => {
    // The bug this pins: applying `rebuild` to every write would delete the previous row's vector each
    // time, leaving exactly one indexed record and no error to show for it.
    for (const n of ["x", "y", "z"]) await addFact(n);
    const r = await backfillEmbeddings(port, {
      embedder: stub(),
      rebuild: true,
    });
    expect(r.embedded).toBe(3);
    expect(vectorRows()).toBe(3);
  });

  it("rebuild is what makes a dimension change possible", async () => {
    await addFact("first model");
    await backfillEmbeddings(port, { embedder: stub(4) });
    expect(vectorRows()).toBe(1);

    // Switching model without --rebuild is refused, loudly, naming the command that fixes it.
    await expect(
      backfillEmbeddings(port, { embedder: stub(8) }),
    ).rejects.toThrow(/dimension changed/);

    // With it, the index is re-created at the new width.
    const r = await backfillEmbeddings(port, {
      embedder: stub(8),
      rebuild: true,
    });
    expect(r.embedded).toBe(1);
    expect(vectorRows()).toBe(1);
  });
});

describe("backfillAuthorship on a database older than the rules", () => {
  it("repairs what it can and names what it cannot, instead of dying halfway", async () => {
    // This is the one path that re-commits provenance it READ rather than provenance a caller
    // supplied, so it is where old rows meet today's gate. When the gate learned to require a real
    // ISO 8601 instant, one legacy `occurred_at` threw out of the loop: the repair command died
    // partway through a database it exists to repair, edges already written, no report of how many.
    const port = new SqliteStorage(":memory:");
    await port.init();
    const legacy = (id: string, occurred_at: string) =>
      port.putEntity({
        id,
        type: "fact",
        attributes: { statement: id },
        status: "verified",
        version: 1,
        last_confirmed: "2026-01-01T00:00:00Z",
        provenance: { actor: `author-${id}`, origin: "cli", occurred_at },
      });
    // Ordered so the unusable row is NOT last: a loop that throws would lose the rows after it.
    await legacy("a-good", "2026-01-01T00:00:00Z");
    await legacy("b-legacy", "yesterday");
    await legacy("c-good", "2026-01-02T00:00:00Z");

    const res = await backfillAuthorship(port, ont, "2026-08-14T00:00:00Z");
    expect(res.scanned).toBe(3);
    expect(res.created).toBe(2);
    expect(res.unrepairable).toHaveLength(1);
    expect(res.unrepairable?.[0]).toContain("b-legacy@v1");
    // The row AFTER the unusable one still got its edge — that is what "one row's problem" means.
    expect(await port.neighbors("c-good", "authored_by", "out")).toHaveLength(
      1,
    );
    port.close();
  });
});

// backfillOccurredAt — the repair for records whose event time a pre-fix verify overwrote.
// The rows here are written the way the old `transition` wrote them (origin 'lifecycle',
// occurred_at restamped to the verify instant, no `transitioned_at`), because that is the state
// every store written before the fix is in — a store repaired by code that only understands the
// post-fix shape would repair nothing.
describe("backfillOccurredAt", () => {
  const said = "2026-01-05T09:00:00Z";
  const verifiedAt = "2026-08-13T15:26:41Z";
  /** What the gate stored for `said` — it canonicalizes every instant it writes. */
  const saidStored = new Date(said).toISOString();

  /** A record ingested with its own event time, then verified the way the bug did it. */
  async function restamped(statement: string) {
    const { entity } = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement } },
      { actor: "notes", origin: "connector:meeting-notes", occurred_at: said },
      said,
    );
    await port.putEntity({
      ...entity,
      status: "verified",
      version: 2,
      last_confirmed: verifiedAt,
      provenance: {
        actor: "alice",
        origin: "lifecycle",
        occurred_at: verifiedAt,
      },
    });
    return entity.id;
  }

  it("restores the event time from history and reports old -> new", async () => {
    const id = await restamped("said in january");

    const { scanned, changes } = await backfillOccurredAt(port);
    expect(scanned).toBe(1);
    expect(changes).toEqual([{ id, from: verifiedAt, to: saidStored }]);

    const cur = await port.getEntity(id);
    expect(cur?.provenance.occurred_at).toBe(saidStored);
    // Status and freshness are untouched — this repairs metadata, it does not re-verify anything.
    expect(cur?.status).toBe("verified");
    expect(cur?.last_confirmed).toBe(verifiedAt);
    // The instant it displaced is the transition's, and it is kept where the as-of rewind reads it,
    // so the timeline the repair walked past is still the timeline.
    expect(cur?.provenance.transitioned_at).toBe(verifiedAt);
    expect((await versionAsOf(port, id, "2026-08-01T00:00:00Z"))?.version).toBe(
      1,
    );
    expect((await versionAsOf(port, id, verifiedAt))?.status).toBe("verified");
  });

  it("is idempotent and writes nothing on a dry run", async () => {
    const id = await restamped("said in january");

    const dry = await backfillOccurredAt(port, { dryRun: true });
    expect(dry.changes).toHaveLength(1);
    expect((await port.getEntity(id))?.provenance.occurred_at).toBe(verifiedAt);
    expect((await port.getEntity(id))?.version).toBe(2);

    await backfillOccurredAt(port);
    const second = await backfillOccurredAt(port);
    expect(second.changes).toEqual([]);
    expect((await port.getEntity(id))?.version).toBe(3);
  });

  it("leaves a record whose latest version is an edit alone", async () => {
    // An edit states its own event time through the gate. Rewinding that to the first version's is
    // the same bug pointed the other way.
    const { entity } = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "first" } },
      { actor: "notes", origin: "connector:x", occurred_at: said },
      said,
    );
    const edited = "2026-03-20T14:30:00Z";
    await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "corrected" } },
      { actor: "notes", origin: "connector:x", occurred_at: edited },
      edited,
      { existingId: entity.id },
    );

    expect((await backfillOccurredAt(port)).changes).toEqual([]);
    expect((await port.getEntity(entity.id))?.provenance.occurred_at).toBe(
      new Date(edited).toISOString(),
    );
  });
});
