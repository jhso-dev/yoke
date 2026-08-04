// storage-opensearch tests — against a REAL OpenSearch, skipped when none is reachable.
//
// Unlike qdrant there is no fake here, for the same reason neo4j has none: the behaviour under test is
// the ENGINE's — BM25 ranking, prefix-term matching against an analyzer's output, k-NN ordering, and
// near-real-time visibility. A fake would encode this adapter's own beliefs about all four and prove
// none of them. The `fetchImpl` seam stays available for anyone who wants one; the suite deliberately
// does not use it.
//
//   docker run -d --name yoke-opensearch -p 9200:9200 \
//     -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
//     -e DISABLE_INSTALL_DEMO_CONFIG=true -e "OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m" \
//     opensearchproject/opensearch:2
//   YOKE_TEST_OPENSEARCH_URL=http://localhost:9200 npm run test:main
//
// Like the neo4j suite, this ERASES the indices it points at (see the wipe below). Never point it at a
// cluster holding anything you want — docs/BACKENDS.md says why that warning exists.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import { conformanceCases } from "../../ports/conformance-cases.js";
import { makeCompositeStore } from "../storage-composite/index.js";
import { SqliteStorage } from "../storage-sqlite/index.js";
import { OpenSearchStorage } from "./index.js";

const URL_ = process.env.YOKE_TEST_OPENSEARCH_URL;
const USER = process.env.YOKE_TEST_OPENSEARCH_USER;
const PASSWORD = process.env.YOKE_TEST_OPENSEARCH_PASSWORD;

const make = (prefix = "yoketest_") =>
  new OpenSearchStorage({
    url: URL_ as string,
    username: USER,
    password: PASSWORD,
    prefix,
  });

/** Delete every index this suite owns. Prefixed, so a cluster running other things keeps them. */
async function wipe(prefix = "yoketest_"): Promise<void> {
  await fetch(`${URL_}/${prefix}*`, { method: "DELETE" }).catch(() => {});
}

const suite = URL_ ? describe : describe.skip;

suite("StoragePort conformance: opensearch (live)", () => {
  beforeAll(async () => {
    await wipe();
  });

  // A fresh index set per case. The cases are written to be self-scoping (case-unique types and
  // tokens) because the kuzu runner shares one database, but an index per case also keeps one case's
  // vector dimension out of the next one's mapping.
  for (const c of conformanceCases) {
    it(c.name, async () => {
      const prefix = `yoketest_${c.name
        .replace(/[^a-z0-9]+/gi, "_")
        .slice(0, 40)
        .toLowerCase()}_`;
      await wipe(prefix);
      const port = make(prefix);
      await port.init();
      try {
        await c.run(port);
      } finally {
        port.close();
        await wipe(prefix);
      }
    });
  }
});

suite("opensearch policies that are contract, not implementation", () => {
  beforeAll(async () => {
    await wipe();
  });

  const base = {
    type: "note",
    status: "draft" as const,
    last_confirmed: "2026-01-01T00:00:00Z",
    provenance: {
      actor: "t",
      origin: "cli" as const,
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };

  it("keeps only the latest version searchable and enumerable", async () => {
    const prefix = "yoketest_latest_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    await store.putEntity({
      ...base,
      id: "vtxt1",
      version: 1,
      attributes: { title: "zqoldword" },
    });
    await store.putEntity({
      ...base,
      id: "vtxt1",
      version: 2,
      attributes: { title: "zqnewword" },
    });

    // The old text is gone from the searchable set — otherwise a query would match a version that no
    // longer says that, which is why sqlite deletes and re-inserts its FTS row.
    expect(await store.search({ text: "zqoldword" })).toEqual([]);
    const hits = await store.search({ text: "zqnewword" });
    expect(hits.map((h) => h.id)).toEqual(["vtxt1"]);
    expect(hits[0].version).toBe(2);
    // And enumeration returns one row, not two.
    const listed = await store.listEntities({});
    expect(listed.items.map((e) => e.version)).toEqual([2]);
    store.close();
    await wipe(prefix);
  });

  it("ranks by relevance, which needs the exact clause and not just the prefix one", async () => {
    // Regression guard for the trap the neo4j adapter hit with wildcards: a `prefix` query is
    // CONSTANT_SCORE in Lucene, so a query built only from prefixes ranks every hit identically and
    // "best match first" silently degrades to whatever the tiebreak is.
    const prefix = "yoketest_rank_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    const filler = "zqpad1 zqpad2 zqpad3 zqpad4 zqpad5 zqpad6 zqpad7";
    await store.putEntity({
      ...base,
      id: "zzmentions",
      version: 1,
      attributes: { title: `${filler} zqquagga ${filler}` },
    });
    await store.putEntity({
      ...base,
      id: "aaabout",
      version: 1,
      attributes: { title: "zqquagga zqquagga" },
    });
    // Ids chosen so the id tiebreak alone would ALSO produce this order would be no evidence — so
    // check the reverse too: `zzmentions` sorts last by id and is the worse match, and the case below
    // asserts a case where score and id disagree.
    const hits = await store.search({ text: "zqquagga" });
    expect(hits.map((h) => h.id)).toEqual(["aaabout", "zzmentions"]);

    // Score must beat the id tiebreak: here the BETTER match sorts LAST by id.
    await store.putEntity({
      ...base,
      id: "zzbest",
      version: 1,
      attributes: { title: "zqokapi zqokapi" },
    });
    await store.putEntity({
      ...base,
      id: "aaworse",
      version: 1,
      attributes: { title: `${filler} zqokapi ${filler}` },
    });
    const byScore = await store.search({ text: "zqokapi" });
    expect(byScore[0].id).toBe("zzbest");

    // Prefix matching still reaches both — that clause is what does the matching, and dropping it
    // would break conformance case 6b (Korean suffix tolerance).
    const byPrefix = await store.search({ text: "zqokap" });
    expect(byPrefix.map((h) => h.id).sort()).toEqual(["aaworse", "zzbest"]);
    store.close();
    await wipe(prefix);
  });

  it("finds a Korean stem inside a word that carries a particle", async () => {
    // Measured against a real server before this adapter existed: `match: "재시도"` returns 0 hits on
    // text containing `재시도는`, because the standard analyzer keeps the particle attached and
    // OpenSearch ships no Korean morphological analyzer by default (nori is a separate plugin). The
    // required-prefix clause is what makes this work, and this is the case that proves it.
    const prefix = "yoketest_korean_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    await store.putEntity({
      ...base,
      id: "kr1",
      version: 1,
      attributes: { title: "결제 실패 시 재시도는 최대 3회까지만 수행한다" },
    });
    expect((await store.search({ text: "재시도" })).map((h) => h.id)).toEqual([
      "kr1",
    ]);
    expect(
      (await store.search({ text: "결제 재시도" })).map((h) => h.id),
    ).toEqual(["kr1"]);
    store.close();
    await wipe(prefix);
  });

  it("refuses a second vector dimension, and rebuild is the way through", async () => {
    const prefix = "yoketest_dim_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    const e = {
      ...base,
      id: "vdim1",
      version: 1,
      attributes: { title: "dim" },
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
    await wipe(prefix);
  });

  it("returns one vector hit per entity, not one per version", async () => {
    // Measured before the design was chosen: with vectors on the entity documents, a k-NN search
    // returned the same record once per version. Keying the vector index by entity id is what fixes
    // it, and it is the same reason sqlite has `entity_vec` and neo4j has `(:EntityVec)`.
    const prefix = "yoketest_veckey_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    const v = new Float32Array([1, 0, 0, 0]);
    for (const version of [1, 2, 3]) {
      await store.putEntity({
        ...base,
        id: "vk1",
        version,
        attributes: { title: `v${version}` },
        embedding: v,
      });
    }
    const hits = await store.similar(v, 10);
    expect(hits.map((h) => h.id)).toEqual(["vk1"]);
    expect(hits[0].version).toBe(3);
    store.close();
    await wipe(prefix);
  });

  it("reads its own writes without the caller waiting for a refresh", async () => {
    // OpenSearch is near-real-time: a write is searchable only after a refresh. The port contract is
    // read-your-writes, so reads refresh instead of writes forcing one — a segment flush per document
    // would make the bounded-search conformance case (1,005 writes) pathological.
    const prefix = "yoketest_ryow_";
    await wipe(prefix);
    const store = make(prefix);
    await store.init();
    await store.putEntity({
      ...base,
      id: "rw1",
      version: 1,
      attributes: { title: "zqimmediate" },
    });
    // No sleep, no explicit refresh, no retry loop.
    expect(
      (await store.search({ text: "zqimmediate" })).map((h) => h.id),
    ).toEqual(["rw1"]);
    store.close();
    await wipe(prefix);
  });
});

suite("composite: knowledge in opensearch, bookkeeping local", () => {
  const dir = mkdtempSync(join(tmpdir(), "yoke-os-composite-"));
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    // Leave the cluster as it was found. Every other block wipes per case; this one shares indices
    // across its three cases, so the cleanup belongs here — and a suite that leaves indices behind on
    // a cluster someone else is using is the small version of the problem this prefix exists to avoid.
    await wipe("yoketest_comp_");
  });

  beforeAll(async () => {
    await wipe("yoketest_comp_");
  });

  it("puts entities in opensearch and the audit trail in sqlite", async () => {
    const localPath = join(dir, "local.sqlite");
    const local = new SqliteStorage(localPath);
    const store = makeCompositeStore(make("yoketest_comp_"), local);
    await store.init();
    await store.saveOntology(seedOntology());

    const { entity } = await commit(
      store,
      store.loadOntology(),
      { type: "fact", attributes: { statement: "zqsplitcheck" } },
      { actor: "t", origin: "cli", occurred_at: "2026-08-04T00:00:00Z" },
      "2026-08-04T00:00:00Z",
    );
    store.logAudit({
      actor: "t",
      action: "inject",
      detail: `q -> ${entity.id}`,
      at: "2026-08-04T00:00:00Z",
    });

    expect((await store.getEntity(entity.id))?.id).toBe(entity.id);
    expect(store.listAudit().length).toBe(1);
    store.close();

    // The split is real, not cosmetic: the local file has the audit row and NO entities.
    const check = new SqliteStorage(localPath);
    await check.init();
    expect(check.listAudit().length).toBe(1);
    expect((await check.listEntities({})).items).toEqual([]);
    check.close();

    // The knowledge is in opensearch.
    const remote = make("yoketest_comp_");
    await remote.init();
    expect((await remote.getEntity(entity.id))?.id).toBe(entity.id);
    remote.close();
  });

  it("serves the ontology synchronously from a cache the async init filled", async () => {
    const local = new SqliteStorage(join(dir, "ont.sqlite"));
    const store = makeCompositeStore(make("yoketest_comp_"), local);
    await store.init();
    // Written by the test above, into opensearch — a fresh composite reads it back with no local copy.
    expect(store.loadOntology().map((t) => t.name)).toContain("fact");
    store.close();
  });

  it("renames a type across the declaration and every stored row", async () => {
    const local = new SqliteStorage(join(dir, "rename.sqlite"));
    const store = makeCompositeStore(make("yoketest_rn_"), local);
    await store.init();
    await store.saveOntology(seedOntology());
    const { entity } = await commit(
      store,
      store.loadOntology(),
      { type: "fact", attributes: { statement: "zqrenameme" } },
      { actor: "t", origin: "cli", occurred_at: "2026-08-04T00:00:00Z" },
      "2026-08-04T00:00:00Z",
    );
    const changed = await store.renameType("fact", "observation");
    expect(changed).toBeGreaterThan(0);
    const after = await store.getEntity(entity.id);
    expect(after?.type).toBe("observation");
    // The FTS text embeds the type name, so a search by the new name must reach the row.
    expect(
      (await store.search({ text: "zqrenameme" })).map((e) => e.type),
    ).toEqual(["observation"]);
    store.close();
    await wipe("yoketest_rn_");
  });
});
