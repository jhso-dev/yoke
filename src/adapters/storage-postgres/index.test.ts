// storage-postgres tests — against a REAL PostgreSQL, skipped when none is reachable.
//
// No fake carries this suite, for the same reason the opensearch and neo4j suites have none: the
// behaviour under test is the ENGINE's. Whether `to_tsvector('simple', ...)` keeps `parseArgs로` as one
// token, whether a prefix term contributes to `ts_rank`, whether `LIMIT NULL` means unbounded, whether
// `atttypmod` on a pgvector column is the dimension — a fake would encode this adapter's beliefs about
// all four and prove none of them.
//
//   docker run -d --rm --name yoke-pg -e POSTGRES_PASSWORD=test -p 54329:5432 \
//     pgvector/pgvector:pg17
//   # optional second server WITHOUT pgvector, for the absent-capability block:
//   docker run -d --rm --name yoke-pg-novec -e POSTGRES_PASSWORD=test -p 54330:5432 \
//     postgres:17-alpine
//   YOKE_TEST_POSTGRES_URL=postgres://postgres:test@localhost:54329/postgres \
//   YOKE_TEST_POSTGRES_NOVEC_URL=postgres://postgres:test@localhost:54330/postgres npm test
//
// Isolation is per SCHEMA, not per database: every case gets a fresh `yoketest_*` schema and drops it
// after, and `beforeAll` sweeps any left behind by an interrupted run. That is the practical payoff of
// the adapter's `schema` option — a suite that shared one schema would leak one case's vector
// dimension into the next one's mapping, which is exactly what the opensearch suite avoids with a
// per-case index prefix. Unlike that suite this one erases NOTHING it does not own: a database holding
// other things keeps them, as long as they are not in a schema called `yoketest_…`.

import assert from "node:assert/strict";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import type { TypeDef } from "../../core/ontology.js";
import { conformanceCases, makeEntity } from "../../ports/conformance-cases.js";
import type { RemoteStore } from "../storage-composite/index.js";
import { PostgresStorage } from "./index.js";

const URL_ = process.env.YOKE_TEST_POSTGRES_URL;
const NOVEC_URL = process.env.YOKE_TEST_POSTGRES_NOVEC_URL;

const suite = URL_ ? describe : describe.skip;
/** The no-pgvector block needs a SECOND server: the extension is per-database and, once created, not
 * something a test can credibly un-create. */
const novecSuite = NOVEC_URL ? describe : describe.skip;

/** A Postgres identifier is 63 bytes, so the case name is sanitized and clipped. */
function schemaFor(name: string): string {
  return `yoketest_${name
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 40)
    .toLowerCase()}`;
}

async function withAdmin<T>(
  url: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Drop one schema, or every `yoketest_%` schema when no name is given. */
async function wipe(url: string, schema?: string): Promise<void> {
  await withAdmin(url, async (c) => {
    const names = schema
      ? [schema]
      : (
          await c.query<{ nspname: string }>(
            `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'yoketest\\_%'`,
          )
        ).rows.map((r) => r.nspname);
    for (const n of names)
      await c.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`);
  });
}

const make = (url: string, schema: string) =>
  new PostgresStorage({ url, schema });

/** Open a store on a private schema, run `fn`, then take the schema away again. */
async function withStore<T>(
  url: string,
  schema: string,
  fn: (store: PostgresStorage) => Promise<T>,
): Promise<T> {
  await wipe(url, schema);
  const store = make(url, schema);
  await store.init();
  try {
    return await fn(store);
  } finally {
    store.close();
    await wipe(url, schema);
  }
}

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

const vec = (...xs: number[]) => Float32Array.from(xs);

// NOT gated on a server, on purpose: this is the one clause a live run cannot check better than the
// compiler can. `RemoteStore` is structural (SPEC "Remote backends") so nothing imports the composite
// the other way, which also means nothing forces the fit — a missing `renameType` would go unnoticed
// until someone wired `openStore`, in a task that is not this one.
describe("postgres satisfies the composite's remote half", () => {
  it("is assignable to RemoteStore without a server", () => {
    const store = new PostgresStorage({ url: "postgres://u:p@127.0.0.1:1/db" });
    // The assignment IS the assertion; the expect below only stops the value being dead code.
    // `pg` connects lazily, so constructing a store opens no socket.
    const remote: RemoteStore = store;
    expect(typeof remote.renameType).toBe("function");
    store.close();
  });
});

suite("StoragePort conformance: postgres (live)", () => {
  beforeAll(async () => {
    await wipe(URL_ as string);
  });

  for (const c of conformanceCases) {
    // The bounded-search case writes DEFAULT_SEARCH_LIMIT + 5 rows one round trip at a time, so the
    // default 5 s timeout is not the right budget for a networked backend.
    it(c.name, async () => {
      await withStore(URL_ as string, schemaFor(c.name), (port) => c.run(port));
    }, 120_000);
  }
});

suite("postgres policies that are contract, not implementation", () => {
  it("keeps only the latest version searchable and enumerable", async () => {
    await withStore(URL_ as string, "yoketest_latest", async (store) => {
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
      // longer says that. This is what nulling the superseded row's tsvector buys.
      expect(await store.search({ text: "zqoldword" })).toEqual([]);
      const hits = await store.search({ text: "zqnewword" });
      expect(hits.map((h) => h.id)).toEqual(["vtxt1"]);
      expect(hits[0].version).toBe(2);
      expect(
        (await store.listEntities({})).items.map((e) => e.version),
      ).toEqual([2]);
    });
  });

  it("makes the max version searchable even when versions arrive out of order", async () => {
    // The reason the reconcile is "compute which row should carry the tsvector" instead of "null
    // everything below the row I just wrote": the naive form leaves TWO searchable rows for one id here
    // and a search returns the record twice.
    await withStore(URL_ as string, "yoketest_ooo", async (store) => {
      await store.putEntity({
        ...base,
        id: "ooo1",
        version: 2,
        attributes: { title: "zqsecond" },
      });
      await store.putEntity({
        ...base,
        id: "ooo1",
        version: 1,
        attributes: { title: "zqfirst" },
      });
      expect(await store.search({ text: "zqfirst" })).toEqual([]);
      const hits = await store.search({ text: "zqsecond" });
      expect(hits.map((h) => h.version)).toEqual([2]);
    });
  });

  it("ranks by relevance, and score beats the id tiebreak", async () => {
    // Unlike Lucene, a Postgres prefix term is not constant-score: ts_rank counts the positions it hit.
    // This is the case that proves the adapter needs no second "exact" clause to satisfy clause 6.
    await withStore(URL_ as string, "yoketest_rank", async (store) => {
      const filler = "zqpad1 zqpad2 zqpad3 zqpad4 zqpad5 zqpad6 zqpad7";
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
      // The BETTER match sorts LAST by id, so passing this cannot be an accident of the tiebreak.
      expect((await store.search({ text: "zqokapi" }))[0].id).toBe("zzbest");
      // And the prefix half still reaches both — that clause does the matching, and dropping it would
      // break conformance case 6b.
      expect(
        (await store.search({ text: "zqokap" })).map((h) => h.id).sort(),
      ).toEqual(["aaworse", "zzbest"]);
    });
  });

  it("finds a Korean stem inside a word that carries a particle", async () => {
    // Measured: `to_tsvector('simple', ...)` lexes `재시도는` as one token, so an equality query for
    // `재시도` returns nothing and the prefix term is what makes this work. Also the reason the
    // configuration is `simple` — `english` would stem the ASCII half unpredictably and drop stopwords.
    await withStore(URL_ as string, "yoketest_korean", async (store) => {
      await store.putEntity({
        ...base,
        id: "kr1",
        version: 1,
        attributes: { title: "결제 실패 시 재시도는 최대 3회까지만 수행한다" },
      });
      expect((await store.search({ text: "재시도" })).map((h) => h.id)).toEqual(
        ["kr1"],
      );
      expect(
        (await store.search({ text: "결제 재시도" })).map((h) => h.id),
      ).toEqual(["kr1"]);
    });
  });

  it("applies the status filter before the limit, in either spelling", async () => {
    await withStore(URL_ as string, "yoketest_status", async (store) => {
      for (const [id, status] of [
        ["st1", "draft"],
        ["st2", "verified"],
        ["st3", "deprecated"],
      ] as const) {
        await store.putEntity({
          ...base,
          id,
          version: 1,
          status,
          attributes: { title: "zqstatusword" },
        });
      }
      const single = await store.search({
        text: "zqstatusword",
        status: "verified",
      });
      expect(single.map((e) => e.id)).toEqual(["st2"]);
      const many = await store.search({
        text: "zqstatusword",
        status: ["verified", "draft"],
      });
      expect(many.map((e) => e.id).sort()).toEqual(["st1", "st2"]);
      // Filter first, THEN cut: a limit of 1 over a filtered set of two is one of the two, never a
      // record the filter excluded.
      const capped = await store.search({
        text: "zqstatusword",
        status: ["verified", "draft"],
        limit: 1,
      });
      expect(capped.length).toBe(1);
      expect(["st1", "st2"]).toContain(capped[0].id);
    });
  });

  it("reads many ids in one round trip, in the order asked for", async () => {
    await withStore(URL_ as string, "yoketest_batch", async (store) => {
      const a = makeEntity({ type: "pgBatch" });
      const b = makeEntity({ type: "pgBatch" });
      await store.putEntity(a);
      await store.putEntity(b);
      await store.putEntity({ ...b, version: 2, status: "verified" });
      const got = await store.getEntities([b.id, a.id, b.id, "absent"]);
      expect(got.map((e) => `${e.id}@${e.version}`)).toEqual([
        `${b.id}@2`,
        `${a.id}@1`,
      ]);
    });
  });
});

suite("postgres ontology (the RemoteStore half)", () => {
  const def = (
    name: string,
    kind: "entity" | "relation" = "entity",
  ): TypeDef => ({
    name,
    kind,
    attrs: { statement: { type: "string", required: true } },
  });

  it("round-trips an append-only ontology and returns the latest def per name", async () => {
    await withStore(URL_ as string, "yoketest_ont", async (store) => {
      await store.saveOntology([def("fact"), def("cites", "relation")]);
      expect((await store.loadOntology()).map((t) => t.name)).toEqual([
        "fact",
        "cites",
      ]);
      // A second save of the same name APPENDS a version; the load sees only the newest.
      await store.saveOntology([{ ...def("fact"), ttl_days: 30 }]);
      const loaded = await store.loadOntology();
      expect(loaded.map((t) => t.name)).toEqual(["fact", "cites"]);
      expect(loaded[0].ttl_days).toBe(30);
    });
  });

  it("overlays tenant defs on the shared base, preserving shared order", async () => {
    await withStore(URL_ as string, "yoketest_ontns", async (store) => {
      await store.saveOntology([def("fact"), def("decision"), def("person")]);
      await store.saveOntology(
        [{ ...def("decision"), ttl_days: 7 }, def("ticket")],
        "tenant-a",
      );
      // Omitted ns = the shared base alone, unaffected by the tenant's declarations.
      expect((await store.loadOntology()).map((t) => t.name)).toEqual([
        "fact",
        "decision",
        "person",
      ]);
      const tenant = await store.loadOntology("tenant-a");
      // The tenant def replaces its same-name entry IN PLACE; tenant-only types append.
      expect(tenant.map((t) => t.name)).toEqual([
        "fact",
        "decision",
        "person",
        "ticket",
      ]);
      expect(tenant.find((t) => t.name === "decision")?.ttl_days).toBe(7);
    });
  });

  it("renames a type across the declaration, every stored row, and the search text", async () => {
    await withStore(URL_ as string, "yoketest_rename", async (store) => {
      await store.saveOntology([def("fact"), def("cites", "relation")]);
      const e1 = makeEntity({ type: "fact", attributes: { s: "zqrenameme" } });
      await store.putEntity(e1);
      // A superseded version too: the rename must reach HISTORY, not just the latest row.
      await store.putEntity({ ...e1, version: 2, status: "verified" });
      const other = makeEntity({
        type: "note",
        attributes: { s: "zqleaveme" },
      });
      await store.putEntity(other);
      await store.putRelation({
        ...base,
        id: "rn-rel",
        version: 1,
        type: "cites",
        attributes: {},
        from: e1.id,
        to: other.id,
      });

      const changed = await store.renameType("fact", "observation");
      // Two entity versions + one declaration row. The relation type is a different name, untouched.
      expect(changed).toBe(3);
      expect((await store.getEntity(e1.id))?.type).toBe("observation");
      expect((await store.getEntity(e1.id, 1))?.type).toBe("observation");
      expect((await store.getEntity(other.id))?.type).toBe("note");
      // The searchable text embeds the type name, so it has to be rebuilt — and rebuilt only on the
      // latest row, or the rename would resurrect a superseded version into the search index.
      expect(
        (await store.search({ text: "zqrenameme" })).map(
          (e) => `${e.type}@${e.version}`,
        ),
      ).toEqual(["observation@2"]);
      expect((await store.search({ text: "observation" })).length).toBe(1);
      expect((await store.loadOntology()).map((t) => t.name)).toEqual([
        "observation",
        "cites",
      ]);

      // Relations rename through the same call, with no `kind` argument from the caller.
      expect(await store.renameType("cites", "references")).toBe(2);
      expect((await store.neighbors(e1.id))[0].type).toBe("references");
    });
  });

  // The case above cannot see WHICH key the rename left behind: it searches for words that both the
  // prose key and the old `type || attributes::text` one carry. This one picks tokens that separate
  // them — the prose key indexes attribute VALUES and the `sources` span, never the attribute NAMES —
  // so a rename that rebuilds the key in SQL instead of through `serializeText` fails here.
  it("rebuilds the index key through serializeText, not from the raw JSON", async () => {
    await withStore(URL_ as string, "yoketest_rename_key", async (store) => {
      await store.saveOntology([def("fact")]);
      const e = makeEntity({
        type: "fact",
        attributes: { zqattrname: "zqvalue", sources: "zqspanword" },
      });
      await store.putEntity(e);
      // One entity version + the declaration.
      expect(await store.renameType("fact", "observation")).toBe(2);
      // The `sources` span is still in the key...
      expect(
        (await store.search({ text: "zqspanword" })).map((x) => x.id),
      ).toEqual([e.id]);
      // ...and the attribute names still are not.
      expect(await store.search({ text: "zqattrname" })).toEqual([]);
    });
  });
});

suite("postgres vectors (pgvector present)", () => {
  it("returns the nearest k in cosine order, with the vector restored", async () => {
    await withStore(URL_ as string, "yoketest_knn", async (store) => {
      assert.ok(store.putEmbedding && store.similar, "pgvector expected here");
      const rows = [
        { id: "near", v: vec(1, 0, 0, 0) },
        { id: "mid", v: vec(0.9, 0.4, 0, 0) },
        { id: "far", v: vec(0, 0, 0, 1) },
      ];
      for (const r of rows) {
        await store.putEntity({
          ...base,
          id: r.id,
          version: 1,
          attributes: { title: r.id },
        });
        await store.putEmbedding({
          ...base,
          id: r.id,
          version: 1,
          attributes: {},
          embedding: r.v,
        });
      }
      const hits = await store.similar(vec(1, 0, 0, 0), 2);
      expect(hits.map((h) => h.id)).toEqual(["near", "mid"]);
      // The vector comes back on the row: commit's duplicate detection filters on
      // `c.embedding !== undefined` and computes cosine itself, so dropping it would turn duplicate
      // detection into a no-op that still reports "embedding".
      expect(Array.from(hits[0].embedding as Float32Array)).toEqual([
        1, 0, 0, 0,
      ]);
      // One hit per id even across versions — the vector table is keyed by id, not by (id, version).
      await store.putEntity({
        ...base,
        id: "near",
        version: 2,
        attributes: { title: "near again" },
      });
      const again = await store.similar(vec(1, 0, 0, 0), 5);
      expect(again.filter((h) => h.id === "near").length).toBe(1);
      expect(again[0].version).toBe(2);
    });
  });

  it("refuses a second dimension on write AND on read, and rebuild is the way through", async () => {
    await withStore(URL_ as string, "yoketest_dim", async (store) => {
      assert.ok(store.putEmbedding && store.similar, "pgvector expected here");
      const e = { ...base, id: "vdim1", version: 1, attributes: { t: "dim" } };
      await store.putEntity(e);
      await store.putEmbedding({
        ...e,
        embedding: new Float32Array(4).fill(0.5),
      });

      // The refusal must name BOTH widths and the command that repairs it — one message, from core, so
      // a person hitting this on two backends does not have to work out whether it is the same problem.
      const both = /holds 4-dimension vectors and this .* is 6/;
      const repair = /yoke backfill --embeddings --rebuild/;
      await expect(
        store.putEmbedding({ ...e, embedding: new Float32Array(6).fill(0.5) }),
      ).rejects.toThrow(both);
      await expect(
        store.putEmbedding({ ...e, embedding: new Float32Array(6).fill(0.5) }),
      ).rejects.toThrow(repair);
      // Reads too: without this, a model change answers queries out of the OLD vector space.
      await expect(
        store.similar(new Float32Array(6).fill(0.5), 3),
      ).rejects.toThrow(both);
      await expect(
        store.similar(new Float32Array(6).fill(0.5), 3),
      ).rejects.toThrow(repair);

      // rebuild is the only way to change dimension — the width lives in the column type.
      await store.putEmbedding(
        { ...e, embedding: new Float32Array(6).fill(0.5) },
        { rebuild: true },
      );
      const hits = await store.similar(new Float32Array(6).fill(0.5), 3);
      expect(hits.map((h) => h.id)).toEqual(["vdim1"]);
      // And the old 4-wide vectors are gone rather than reinterpreted.
      await expect(
        store.similar(new Float32Array(4).fill(0.5), 3),
      ).rejects.toThrow(/holds 6-dimension vectors/);
    });
  });

  it("answers similar() with an empty list before any vector exists", async () => {
    await withStore(URL_ as string, "yoketest_novecrow", async (store) => {
      assert.ok(store.similar, "pgvector expected here");
      // No table yet is an empty index, not an error — the state every store is in before a commit
      // ever ran with a working embedder.
      expect(await store.similar(vec(1, 2, 3), 5)).toEqual([]);
    });
  });
});

novecSuite("postgres without pgvector", () => {
  beforeAll(async () => {
    await wipe(NOVEC_URL as string);
  });

  it("leaves similar and putEmbedding genuinely ABSENT after init", async () => {
    await withStore(NOVEC_URL as string, "yoketest_absent", async (store) => {
      // Not present-and-throwing: `commit` and the hybrid retriever branch on
      // `typeof port.similar === "function"`, so a method that exists and fails would take them into a
      // hard error instead of the keyword fallback.
      expect(store.similar).toBeUndefined();
      expect(store.putEmbedding).toBeUndefined();
      expect("similar" in store).toBe(false);
      expect("putEmbedding" in store).toBe(false);
    });
  });

  it("still serves knowledge, search and enumeration", async () => {
    await withStore(
      NOVEC_URL as string,
      "yoketest_novec_smoke",
      async (store) => {
        const e = makeEntity({ attributes: { title: "zqnovector basics" } });
        await store.putEntity(e);
        expect((await store.getEntity(e.id))?.id).toBe(e.id);
        expect(
          (await store.search({ text: "zqnovector" })).map((x) => x.id),
        ).toEqual([e.id]);
        expect((await store.listEntities({})).items.map((x) => x.id)).toEqual([
          e.id,
        ]);
        await store.saveOntology([
          { name: "fact", kind: "entity", attrs: {} } as TypeDef,
        ]);
        expect((await store.loadOntology()).map((t) => t.name)).toEqual([
          "fact",
        ]);
      },
    );
  });

  // A representative slice of the shared contract, so "works without pgvector" is checked against the
  // suite rather than against this file's opinion of what matters. The two vector cases in the shared
  // set self-skip on a port with no `similar`, which is what makes the whole set safe to run here.
  const representative = new Set([
    "round-trips putEntity → getEntity",
    "keeps every version on re-put; getEntity returns latest, version selects past",
    "search treats multi-word queries as AND of prefix terms, any order",
    "exposes similar as optional capability (undefined or function)",
    "listEntities paginates by keyset cursor without gaps or duplicates",
  ]);
  for (const c of conformanceCases.filter((x) => representative.has(x.name))) {
    it(c.name, async () => {
      await withStore(
        NOVEC_URL as string,
        `${schemaFor(c.name)}_nv`.slice(0, 63),
        (port) => c.run(port),
      );
    }, 120_000);
  }
});
