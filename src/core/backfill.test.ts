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
import { backfillEmbeddings } from "./backfill.js";
import { commit } from "./commit.js";
import { type Embedder, serializeText } from "./embedding.js";
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
    await addFact("kuzu-shaped");
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
