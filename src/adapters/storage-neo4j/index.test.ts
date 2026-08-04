// storage-neo4j tests — against a REAL Neo4j, skipped when none is reachable.
//
// No fake. The qdrant adapter's in-memory REST fake is defensible because Qdrant's filter surface is a
// handful of JSON shapes; Cypher is a query language, so a fake would encode the same assumptions as
// the adapter and conformance against it would prove nothing. The cost of that honesty is that this
// suite is conditional locally — CI runs it as a service container so it is never only skipped.
//
//   docker run -d --rm --name yoke-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/testtest neo4j:5
//   YOKE_TEST_NEO4J_URL=bolt://localhost:7687 npm run test:main

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import { conformanceCases } from "../../ports/conformance-cases.js";
import { makeCompositeStore } from "../storage-composite/index.js";
import { SqliteStorage } from "../storage-sqlite/index.js";
import { Neo4jStorage } from "./index.js";

const URL_ = process.env.YOKE_TEST_NEO4J_URL;
const USER = process.env.YOKE_TEST_NEO4J_USER ?? "neo4j";
const PASSWORD = process.env.YOKE_TEST_NEO4J_PASSWORD ?? "testtest";

const make = () =>
  new Neo4jStorage({ url: URL_ as string, user: USER, password: PASSWORD });

/** Nodes AND yoke's own indexes/constraints. `DETACH DELETE` leaves indexes behind, and a leftover
 * vector index still declares its dimension — so wiping only nodes makes the next differently-sized
 * write fail, correctly but confusingly. Constraints drop first: an index a constraint owns cannot be
 * dropped on its own. */
async function wipe(): Promise<void> {
  const store = make();
  const run = (
    store as unknown as { run(c: string): Promise<Record<string, unknown>[]> }
  ).run.bind(store);
  await run("MATCH (x) DETACH DELETE x");
  for (const [show, drop] of [
    ["CONSTRAINTS", "CONSTRAINT"],
    ["INDEXES", "INDEX"],
  ]) {
    const rows = await run(`SHOW ${show} YIELD name RETURN name`);
    for (const r of rows) {
      const name = String(r.name);
      if (!name.startsWith("yoke_")) continue;
      await run(`DROP ${drop} ${name} IF EXISTS`).catch(() => {
        // Owned by a constraint that the pass above already removed.
      });
    }
  }
  store.close();
}

const suite = URL_ ? describe : describe.skip;

suite("StoragePort conformance: neo4j (live)", () => {
  let port: Neo4jStorage;

  beforeAll(async () => {
    await wipe();
  });

  // Per-case isolation like the shared vitest wrapper gives every other adapter. The cases are written
  // to be self-scoping (case-unique types and tokens) because the kuzu runner shares one database, so
  // a shared graph here is safe too — but a fresh connection per case keeps the vector-index state
  // from one case out of the next.
  for (const c of conformanceCases) {
    it(c.name, async () => {
      port = make();
      await port.init();
      try {
        await c.run(port);
      } finally {
        port.close();
      }
    });
  }
});

suite("neo4j policies that are contract, not implementation", () => {
  beforeAll(async () => {
    await wipe();
  });

  it("keeps only the latest version searchable", async () => {
    const store = make();
    await store.init();
    const base = {
      id: "vtxt1",
      type: "note",
      status: "draft" as const,
      last_confirmed: "2026-01-01T00:00:00Z",
      provenance: {
        actor: "t",
        origin: "cli" as const,
        occurred_at: "2026-01-01T00:00:00Z",
      },
    };
    await store.putEntity({
      ...base,
      version: 1,
      attributes: { title: "zqoldword" },
    });
    await store.putEntity({
      ...base,
      version: 2,
      attributes: { title: "zqnewword" },
    });

    // The old text is gone from the index — otherwise a query would match a version that no longer
    // says that, which is the reason sqlite deletes and re-inserts its FTS row.
    expect(await store.search({ text: "zqoldword" })).toEqual([]);
    const hits = await store.search({ text: "zqnewword" });
    expect(hits.map((h) => h.id)).toEqual(["vtxt1"]);
    expect(hits[0].version).toBe(2);
    store.close();
  });

  it("ranks by relevance, which needs the exact clause and not just the prefix one", async () => {
    // Regression guard for the bug the conformance suite caught: Lucene rewrites a wildcard as a
    // CONSTANT_SCORE query, so `+tok*` alone scored every hit identically and "best match first"
    // silently degraded to id order.
    const store = make();
    await store.init();
    const base = {
      type: "note",
      status: "draft" as const,
      version: 1,
      last_confirmed: "2026-01-01T00:00:00Z",
      provenance: {
        actor: "t",
        origin: "cli" as const,
        occurred_at: "2026-01-01T00:00:00Z",
      },
    };
    const filler = "zqpad1 zqpad2 zqpad3 zqpad4 zqpad5 zqpad6 zqpad7";
    await store.putEntity({
      ...base,
      id: "zzmentions",
      attributes: { title: `${filler} zqquagga ${filler}` },
    });
    await store.putEntity({
      ...base,
      id: "aaabout",
      attributes: { title: "zqquagga zqquagga" },
    });
    // Ids chosen so the id tiebreak would produce the WRONG order: `zzmentions` was stored first and
    // sorts last, so if scoring collapsed to constant the query's `ORDER BY score DESC, e.id ASC`
    // would still put `aaabout` first — which is why the ids are the other way round from the
    // conformance case, and why this asserts the id that does NOT win on either fallback.
    const hits = await store.search({ text: "zqquagga" });
    expect(hits).toHaveLength(2);
    expect(hits[0].id).toBe("aaabout");
    expect(hits[1].id).toBe("zzmentions");

    // Prefix matching still reaches both — the required `+tok*` clause is what does the matching, and
    // removing it in favour of the exact term alone would break conformance case 6b.
    const byPrefix = await store.search({ text: "zqquag" });
    expect(byPrefix.map((h) => h.id).sort()).toEqual(["aaabout", "zzmentions"]);
    store.close();
  });

  it("refuses a second vector dimension, and rebuild is the way through", async () => {
    const store = make();
    await store.init();
    const e = {
      id: "vdim1",
      type: "note",
      status: "draft" as const,
      version: 1,
      attributes: { title: "dim" },
      last_confirmed: "2026-01-01T00:00:00Z",
      provenance: {
        actor: "t",
        origin: "cli" as const,
        occurred_at: "2026-01-01T00:00:00Z",
      },
    };
    await store.putEntity(e);
    await store.putEmbedding({
      ...e,
      embedding: new Float32Array(4).fill(0.5),
    });
    await expect(
      store.putEmbedding({ ...e, embedding: new Float32Array(6).fill(0.5) }),
    ).rejects.toThrow(/dimension changed.*backfill --embeddings --rebuild/s);
    await store.putEmbedding(
      { ...e, embedding: new Float32Array(6).fill(0.5) },
      { rebuild: true },
    );
    const hits = await store.similar(new Float32Array(6).fill(0.5), 3);
    expect(hits.map((h) => h.id)).toEqual(["vdim1"]);
    store.close();
  });
});

suite("composite: knowledge remote, bookkeeping local", () => {
  const dir = mkdtempSync(join(tmpdir(), "yoke-composite-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeAll(async () => {
    await wipe();
  });

  it("puts entities in neo4j and the audit trail in sqlite", async () => {
    const localPath = join(dir, "local.sqlite");
    const local = new SqliteStorage(localPath);
    const store = makeCompositeStore(make(), local);
    await store.init();
    await store.saveOntology(seedOntology());

    const { entity } = await commit(
      store,
      store.loadOntology(),
      { type: "fact", attributes: { statement: "zqsplitcheck" } },
      { actor: "t", origin: "cli", occurred_at: "2026-08-03T00:00:00Z" },
      "2026-08-03T00:00:00Z",
    );
    store.logAudit({
      actor: "t",
      action: "inject",
      detail: `q -> ${entity.id}`,
      at: "2026-08-03T00:00:00Z",
    });

    // Readable through the composite…
    expect((await store.getEntity(entity.id))?.id).toBe(entity.id);
    expect(store.listAudit().length).toBe(1);
    store.close();

    // …and the split is real, not cosmetic: the local file has the audit row and NO entities.
    const check = new SqliteStorage(localPath);
    await check.init();
    expect(check.listAudit().length).toBe(1);
    expect((await check.listEntities({})).items).toEqual([]);
    check.close();

    // The knowledge is in neo4j.
    const remote = make();
    await remote.init();
    expect((await remote.getEntity(entity.id))?.id).toBe(entity.id);
    remote.close();
  });

  it("serves the ontology synchronously from a cache the async init filled", async () => {
    const local = new SqliteStorage(join(dir, "ont.sqlite"));
    const store = makeCompositeStore(make(), local);
    await store.init();
    // Written by the test above, into neo4j — so a fresh composite reads it back with no local copy.
    expect(store.loadOntology().map((t) => t.name)).toContain("fact");
    store.close();
  });

  it("omits listHistory so listVersions falls back, and history still reads in order", async () => {
    const { listVersions } = await import("../../core/lifecycle.js");
    const local = new SqliteStorage(join(dir, "hist.sqlite"));
    const store = makeCompositeStore(make(), local);
    await store.init();
    // The extension is genuinely absent — `listVersions` probes for the property, so a
    // present-but-throwing method would break the fallback instead of triggering it.
    expect(
      (store as unknown as { listHistory?: unknown }).listHistory,
    ).toBeUndefined();

    const base = {
      id: "zqhist1",
      type: "note",
      status: "draft" as const,
      attributes: { title: "h" },
      last_confirmed: "2026-01-01T00:00:00Z",
      provenance: {
        actor: "t",
        origin: "cli" as const,
        occurred_at: "2026-01-01T00:00:00Z",
      },
    };
    await store.putEntity({ ...base, version: 1 });
    await store.putEntity({ ...base, version: 2, status: "verified" });
    const versions = await listVersions(store, "zqhist1");
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    store.close();
  });

  it("refuses backup and export rather than producing a half one", async () => {
    const local = new SqliteStorage(join(dir, "bk.sqlite"));
    const store = makeCompositeStore(make(), local);
    await store.init();
    // A backup covering only the local half would look complete and contain no knowledge.
    await expect(store.backupTo(join(dir, "x.sqlite"))).rejects.toThrow(
      /remote backend/,
    );
    await expect(
      store.exportUntil("2026-08-03T00:00:00Z", join(dir, "y.jsonl")),
    ).rejects.toThrow(/remote backend/);
    store.close();
  });
});
