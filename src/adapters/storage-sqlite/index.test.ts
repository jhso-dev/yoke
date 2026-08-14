// storage-sqlite tests — run the conformance suite against both :memory: and a temp file,
// and check the ontology save/load round-trip.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { seedOntology } from "../../core/ontology.js";
import { describeStoragePort } from "../../ports/conformance.js";
import { SqliteStorage } from "./index.js";

describeStoragePort(":memory:", async () => new SqliteStorage(":memory:"));

const dir = mkdtempSync(join(tmpdir(), "yoke-sqlite-"));
describeStoragePort("temp file", async () => {
  const path = join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  return new SqliteStorage(path);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The runnable check behind the indexes. A timing assertion would be flaky and a row-count
// assertion would pass on a full scan — the plan is the only thing that fails the moment an index
// stops being used. These four queries are the ones measured in docs/SCALE.md, where the same
// filters cost 15 s, 232 ms, 567 ms and 202 ms with no index to use.
/** The private handle, reached structurally rather than through `any` — a plan test needs the
 * connection, and naming the one field it wants keeps the cast honest and lint-clean. */
const handleOf = (store: SqliteStorage): Database.Database =>
  (store as unknown as { db: Database.Database }).db;

describe("the hot reads use an index, not a scan", () => {
  const plan = (db: Database.Database, sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");

  const LATEST = (t: string, a: string) =>
    `${a}.version = (SELECT MAX(version) FROM ${t} WHERE id = ${a}.id)`;

  it("plans a scan of nothing", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const db = handleOf(store);

    const cases: [string, string, string][] = [
      [
        "listEntities({type})",
        `SELECT e.* FROM entities e WHERE ${LATEST("entities", "e")}
           AND e.ns IS NULL AND e.type = 'fact' ORDER BY e.id LIMIT 51`,
        "idx_entities_ns_type_id",
      ],
      [
        "listEntities({status}) — the review queue",
        `SELECT e.* FROM entities e WHERE ${LATEST("entities", "e")}
           AND e.ns IS NULL AND e.status = 'draft' ORDER BY e.id LIMIT 51`,
        "idx_entities_ns_status_id",
      ],
      [
        "listRelations({type}) — conflicts",
        `SELECT r.* FROM relations r WHERE ${LATEST("relations", "r")}
           AND r.ns IS NULL AND r.type = 'conflicts_with' ORDER BY r.id LIMIT 51`,
        "idx_relations_ns_type_id",
      ],
    ];
    for (const [name, sql, index] of cases)
      expect(plan(db, sql), name).toContain(index);

    // neighbors' disjunction needs BOTH single-column indexes, via MULTI-INDEX OR. Asserting the
    // OR strategy too, because one index alone would still read "USING INDEX" while scanning for
    // the other side.
    const nb = plan(
      db,
      `SELECT r.* FROM relations r WHERE ${LATEST("relations", "r")}
         AND (r.from_id = 'x' OR r.to_id = 'x')`,
    );
    expect(nb).toContain("MULTI-INDEX OR");
    expect(nb).toContain("idx_relations_from");
    expect(nb).toContain("idx_relations_to");

    store.close();
  });

  it("would fail if the index were dropped", async () => {
    // Non-vacuity, and it corrected the assertion it was written to guard. Dropping the type index
    // does NOT produce a plain "SCAN": SQLite falls back to the status index for its `ns` prefix,
    // filters type per row, and then needs a temp B-tree because the ordering is no longer free.
    // So the regression to detect is the loss of the ORDERED index read, not the appearance of the
    // word SCAN — a test asserting "SCAN" would have failed here for the wrong reason and a test
    // asserting only "some index is named" would never fail at all.
    const store = new SqliteStorage(":memory:");
    await store.init();
    const db = handleOf(store);
    const sql = `SELECT e.* FROM entities e WHERE ${LATEST("entities", "e")}
      AND e.ns IS NULL AND e.type = 'fact' ORDER BY e.id LIMIT 51`;
    expect(plan(db, sql)).toContain("idx_entities_ns_type_id");
    expect(plan(db, sql)).not.toContain("TEMP B-TREE");

    db.exec("DROP INDEX idx_entities_ns_type_id");
    expect(plan(db, sql)).not.toContain("idx_entities_ns_type_id");
    expect(plan(db, sql)).toContain("TEMP B-TREE");
    store.close();
  });

  it("adds the indexes to a database created before they existed", async () => {
    // init() is the upgrade path: CREATE INDEX IF NOT EXISTS runs on every open, so an existing
    // 5 GB database gets them without a migration step. Simulated by dropping and re-opening.
    const path = join(
      dir,
      `upgrade-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    const first = new SqliteStorage(path);
    await first.init();
    handleOf(first).exec("DROP INDEX idx_relations_from");
    first.close();

    const reopened = new SqliteStorage(path);
    await reopened.init();
    const names = (
      handleOf(reopened)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_relations_from");
    reopened.close();
  });
});

describe("ontology save/load", () => {
  it("round-trips the seed ontology", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const seed = seedOntology();
    await store.saveOntology(seed);
    expect(store.loadOntology()).toEqual(seed);
    store.close();
  });
});

describe("sqlite-vec similar", () => {
  const emb = (arr: number[]) => Float32Array.from(arr);
  const base = {
    type: "fact",
    status: "draft" as const,
    version: 1,
    last_confirmed: "2026-01-01T00:00:00Z",
    provenance: {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };

  it("returns [] before any embedding is stored (lazy vec table)", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    expect(await store.similar(emb([1, 0, 0]), 3)).toEqual([]);
    store.close();
  });

  it("returns k nearest ordered by distance", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.putEntity({
      ...base,
      id: "x",
      attributes: { n: "x" },
      embedding: emb([1, 0, 0]),
    });
    await store.putEntity({
      ...base,
      id: "near",
      attributes: { n: "near" },
      embedding: emb([0.9, 0.1, 0]),
    });
    await store.putEntity({
      ...base,
      id: "far",
      attributes: { n: "far" },
      embedding: emb([0, 1, 0]),
    });
    const hits = await store.similar(emb([1, 0, 0]), 2);
    expect(hits.map((h) => h.id)).toEqual(["x", "near"]);
    // Embedding restored (for the gate's cosine judgment).
    expect(hits[0].embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(hits[0].embedding as Float32Array)).toEqual([1, 0, 0]);
    store.close();
  });

  it("keeps only the latest version's vector (delete+insert)", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.putEntity({
      ...base,
      id: "e",
      attributes: { n: "v1" },
      embedding: emb([1, 0, 0]),
    });
    await store.putEntity({
      ...base,
      id: "e",
      version: 2,
      attributes: { n: "v2" },
      embedding: emb([0, 1, 0]),
    });
    const hits = await store.similar(emb([0, 1, 0]), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("e");
    expect(hits[0].attributes).toEqual({ n: "v2" });
    store.close();
  });

  // The shared conformance case for putEmbedding SKIPS when the capability is absent — correct for an
  // optional method, and useless as a non-vacuity check. This is where "sqlite has it" is asserted, so
  // deleting the method fails a test instead of quietly passing everywhere.
  it("implements putEmbedding (the conformance case skips without it)", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    expect(typeof store.putEmbedding).toBe("function");
    store.close();
  });

  describe("one vector space per database", () => {
    it("refuses a different dimension and names the way out", async () => {
      const store = new SqliteStorage(":memory:");
      await store.init();
      await store.putEntity({
        ...base,
        id: "a",
        attributes: { n: "a" },
        embedding: emb([1, 0, 0]),
      });
      // A changed embedding model. Left to sqlite-vec this said "query vector" on a WRITE and named no
      // remedy; a mixed space would return confidently wrong neighbours forever, so this is the one
      // place an embedding problem is allowed to stop a write (SPEC "The vector index").
      await expect(
        store.putEntity({
          ...base,
          id: "b",
          attributes: { n: "b" },
          embedding: emb([1, 0, 0, 0]),
        }),
      ).rejects.toThrow(
        /dimension changed.*3.*4.*backfill --embeddings --rebuild/s,
      );
      store.close();
    });

    it("refuses a READ in the wrong dimension too", async () => {
      const store = new SqliteStorage(":memory:");
      await store.init();
      await store.putEntity({
        ...base,
        id: "a",
        attributes: { n: "a" },
        embedding: emb([1, 0, 0]),
      });
      // Without this the old index would answer the new model's queries — a neighbour list computed in
      // a different vector space, which looks like a result and is not one.
      await expect(store.similar(emb([1, 0, 0, 0]), 3)).rejects.toThrow(
        /dimension changed/,
      );
      store.close();
    });

    it("rebuild is how a model change is applied", async () => {
      const store = new SqliteStorage(":memory:");
      await store.init();
      await store.putEntity({
        ...base,
        id: "a",
        attributes: { n: "a" },
        embedding: emb([1, 0, 0]),
      });
      await store.putEmbedding(
        {
          ...base,
          id: "a",
          attributes: { n: "a" },
          embedding: emb([1, 0, 0, 0]),
        },
        { rebuild: true },
      );
      // The index is now 4-wide: the old vectors are gone (which is why a backfill re-embeds every
      // row rather than only the ones it thinks are missing) and the new width is queryable.
      const hits = await store.similar(emb([1, 0, 0, 0]), 3);
      expect(hits.map((h) => h.id)).toEqual(["a"]);
      // ...and the 3-wide query that used to work is now the one that is refused.
      await expect(store.similar(emb([1, 0, 0]), 3)).rejects.toThrow(
        /dimension changed/,
      );
      store.close();
    });
  });
});

describe("audit extensions (PLAN 8.4)", () => {
  const base = {
    type: "fact",
    status: "draft" as const,
    version: 1,
    last_confirmed: "2026-01-01T00:00:00Z",
    provenance: {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: "2026-01-01T00:00:00Z",
    },
  };

  it("listHistory returns all versions ascending", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.putEntity({ ...base, id: "e", attributes: { n: "v1" } });
    await store.putEntity({
      ...base,
      id: "e",
      version: 2,
      status: "verified",
      attributes: { n: "v2" },
    });
    const history = store.listHistory("e");
    expect(history.map((e) => e.version)).toEqual([1, 2]);
    expect(history.map((e) => e.status)).toEqual(["draft", "verified"]);
    expect(store.listHistory("nope")).toEqual([]);
    store.close();
  });

  it("logAudit/listAudit round-trip with since filter", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const a = {
      actor: "alice",
      action: "inject",
      detail: "cache -> id1 id2",
      at: "2026-01-01T00:00:00Z",
    };
    const b = {
      actor: "bob",
      action: "persona",
      detail: "p1 -> id3",
      at: "2026-02-01T00:00:00Z",
    };
    const tenant = {
      actor: "carol",
      action: "inject",
      detail: "tenant query -> id4",
      at: "2026-03-01T00:00:00Z",
      ns: "acme",
    };
    store.logAudit(a);
    store.logAudit(b);
    store.logAudit(tenant);
    expect(store.listAudit()).toEqual([a, b]);
    expect(store.listAudit({ since: "2026-01-15T00:00:00Z" })).toEqual([b]);
    // Both bounds inclusive — a person picking an end day means through that instant.
    expect(store.listAudit({ until: "2026-01-15T00:00:00Z" })).toEqual([a]);
    expect(store.listAudit({ until: b.at })).toEqual([a, b]);
    expect(store.listAudit({ since: a.at, until: a.at })).toEqual([a]);
    // Namespace isolation: an audit viewer must not show one tenant's queries to another, and the
    // default namespace is not a wildcard over tenants.
    expect(store.listAudit({ ns: "acme" })).toEqual([tenant]);
    expect(store.listAudit({ ns: "globex" })).toEqual([]);
    // limit takes the most recent N but still returns them oldest-first.
    expect(store.listAudit({ limit: 1 })).toEqual([b]);
    expect(store.listAudit({ limit: 5 })).toEqual([a, b]);
    // The bound is compared BY INSTANT (`julianday`), never as text. The text compare this replaced
    // was pinned right here as a caller hazard — "a second-precision `since` sorts AFTER a row inside
    // its own second (`Z` > `.`), silently dropping it" — which is a defect described as a contract:
    // the same hazard, reached through an offset spelling, made `export --until` write an empty
    // disaster-recovery copy with exit 0. A row half a second after the bound is after the bound in
    // every spelling of it.
    const ms = {
      actor: "dave",
      action: "verify",
      detail: "id5",
      at: "2026-04-01T00:00:00.500Z",
    };
    store.logAudit(ms);
    expect(store.listAudit({ since: "2026-04-01T00:00:00.000Z" })).toEqual([
      ms,
    ]);
    expect(store.listAudit({ since: "2026-04-01T00:00:00Z" })).toEqual([ms]);
    expect(store.listAudit({ since: "2026-04-01T09:00:00.500+09:00" })).toEqual(
      [ms],
    );
    expect(store.listAudit({ since: "2026-04-01T00:00:00.501Z" })).toEqual([]);
    store.close();
  });
});

describe("renameType", () => {
  const prov = {
    actor: "yoke:system",
    origin: "cli",
    occurred_at: "2026-01-01T00:00:00Z",
  };
  const ent = (id: string, type: string, version = 1, ns?: string) => ({
    id,
    version,
    type,
    status: "verified" as const,
    attributes: { title: `${id} v${version}` },
    provenance: prov,
    last_confirmed: "2026-01-01T00:00:00Z",
    ...(ns ? { ns } : {}),
  });

  it("leaves the old name nowhere — declaration, every version, and the search index", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.saveOntology([
      { name: "old", kind: "entity", attrs: {} },
      { name: "fact", kind: "entity", attrs: {} },
    ]);
    await store.putEntity(ent("e1", "old"));
    await store.putEntity(ent("e1", "old", 2));
    await store.putEntity(ent("keep", "fact"));

    expect(await store.renameType("old", "new")).toBe(3); // 2 versions + 1 declaration

    // Every version, not just the latest: a rename that only fixes the head leaves `yoke history`
    // reading in the old vocabulary, which is the half-rename this command exists to prevent.
    expect(store.listHistory("e1").map((e) => e.type)).toEqual(["new", "new"]);
    expect(
      store
        .loadOntology()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["fact", "new"]);
    // The FTS text is built from type + attributes, so it goes stale silently on a bare UPDATE —
    // the old name would stay findable by search while appearing nowhere on screen.
    expect((await store.search({ text: "old" })).map((e) => e.id)).toEqual([]);
    expect((await store.search({ text: "new" })).map((e) => e.id)).toEqual([
      "e1",
    ]);
    // Untouched types keep their rows and their index entry.
    expect((await store.getEntity("keep"))?.type).toBe("fact");
    store.close();
  });

  it("renames a relation type, and scopes to one namespace", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.putEntity(ent("a", "fact"));
    await store.putEntity(ent("b", "fact"));
    await store.putRelation({
      id: "r1",
      version: 1,
      type: "works_on",
      status: "verified",
      attributes: {},
      provenance: prov,
      last_confirmed: "2026-01-01T00:00:00Z",
      from: "a",
      to: "b",
    });
    expect(await store.renameType("works_on", "assigned_to")).toBe(1);
    expect((await store.neighbors("a")).map((r) => r.type)).toEqual([
      "assigned_to",
    ]);

    // One tenant renaming does not touch another's rows — the same guarantee every other query has.
    await store.putEntity(ent("t1", "shared", 1, "acme"));
    await store.putEntity(ent("t2", "shared", 1, "globex"));
    expect(await store.renameType("shared", "common", "acme")).toBe(1);
    expect((await store.getEntity("t1"))?.type).toBe("common");
    expect((await store.getEntity("t2"))?.type).toBe("shared");
    store.close();
  });

  it("drops the stale declaration when the new name is already declared", async () => {
    // The ordinary case: the code was renamed first, so a later `yoke init` seeded the new type
    // beside the old one. Rewriting the old row's name would collide with the live one.
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.saveOntology([{ name: "old", kind: "entity", attrs: {} }]);
    await store.saveOntology([{ name: "new", kind: "entity", attrs: {} }]);
    await store.putEntity(ent("e", "old"));
    expect(await store.renameType("old", "new")).toBe(2); // 1 version + 1 dropped declaration
    expect(store.loadOntology().map((d) => d.name)).toEqual(["new"]);
    expect((await store.getEntity("e"))?.type).toBe("new");
    store.close();
  });

  it("reports zero rather than failing when nothing carries the name", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    expect(await store.renameType("absent", "whatever")).toBe(0);
    store.close();
  });
});

describe("durability (PLAN-V2 11.1)", () => {
  const prov = {
    actor: "yoke:system",
    origin: "cli",
    occurred_at: "2026-01-01T00:00:00Z",
  };

  it("exportUntil reconstructs state as of the cut, dropping later versions", async () => {
    const srcPath = join(dir, `pitr-${Math.random().toString(36).slice(2)}.db`);
    const store = new SqliteStorage(srcPath);
    await store.init();
    await store.saveOntology(seedOntology());
    // v1 draft, v2 verified — same id, append-only.
    await store.putEntity({
      id: "e",
      version: 1,
      type: "fact",
      status: "draft",
      attributes: { title: "v1" },
      provenance: prov,
      last_confirmed: "2026-01-01T00:00:00Z",
    });
    await store.putEntity({
      id: "e",
      version: 2,
      type: "fact",
      status: "verified",
      attributes: { title: "v2" },
      provenance: prov,
      last_confirmed: "2026-01-02T00:00:00Z",
    });
    // created_at is a DB-default server clock (whole-second) — set it deterministically for the test
    // via a side connection so the cut lands cleanly between the two versions.
    const raw = new Database(srcPath);
    const setAt = raw.prepare(
      "UPDATE entities SET created_at = ? WHERE id = ? AND version = ?",
    );
    setAt.run("2026-01-01T00:00:00Z", "e", 1);
    setAt.run("2026-01-02T00:00:00Z", "e", 2);
    raw.close();

    const outPath = join(
      dir,
      `pitr-out-${Math.random().toString(36).slice(2)}.db`,
    );
    await store.exportUntil("2026-01-01T12:00:00Z", outPath);
    store.close();

    const ex = new SqliteStorage(outPath);
    await ex.init();
    // Only v1 (the draft) survived the cut.
    expect(ex.listHistory("e").map((e) => e.version)).toEqual([1]);
    const latest = await ex.getEntity("e");
    expect(latest?.status).toBe("draft");
    expect(latest?.attributes).toEqual({ title: "v1" });
    // Ontology carried over (a reconstructed DB must be usable) and FTS was rebuilt from v1.
    expect(ex.loadOntology().length).toBeGreaterThan(0);
    expect((await ex.search({ text: "v1" })).map((e) => e.id)).toContain("e");
    expect(await ex.search({ text: "v2" })).toEqual([]);
    ex.close();
  });

  it("backupTo produces a standalone consistent copy", async () => {
    const srcPath = join(dir, `bak-${Math.random().toString(36).slice(2)}.db`);
    const store = new SqliteStorage(srcPath);
    await store.init();
    await store.saveOntology(seedOntology());
    await store.putEntity({
      id: "k",
      version: 1,
      type: "fact",
      status: "verified",
      attributes: { title: "keep" },
      provenance: prov,
      last_confirmed: "2026-01-01T00:00:00Z",
    });
    const dest = join(dir, `bak-out-${Math.random().toString(36).slice(2)}.db`);
    await store.backupTo(dest);
    store.close();

    const copy = new SqliteStorage(dest);
    await copy.init();
    expect((await copy.getEntity("k"))?.attributes).toEqual({ title: "keep" });
    copy.close();
  });
});

// A pre-10.1 database on the current binary. Every command died on a bare "no such column: ns", and
// `yoke init` — the one repair the migration's own comment promises — died at the same line, because
// SCHEMA declares indexes over `ns` and ran BEFORE the ALTER TABLE that adds it. `restore` then
// reported exit 0 for a file that could not be opened. Git dates it: the ns migration landed
// 2026-07-13, the ns indexes joined SCHEMA on 2026-08-03.
describe("opening a database from before the ns migration", () => {
  /** A current database with the 10.1+ columns and indexes stripped back off. */
  function pre101(): string {
    const path = join(dir, `old-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(path);
    db.exec(`
      CREATE TABLE entities (
        id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, attributes TEXT NOT NULL, provenance TEXT NOT NULL,
        last_confirmed TEXT NOT NULL, PRIMARY KEY (id, version));
      CREATE TABLE relations (
        id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, attributes TEXT NOT NULL,
        provenance TEXT NOT NULL, status TEXT NOT NULL, last_confirmed TEXT NOT NULL,
        PRIMARY KEY (id, version));
      CREATE TABLE ontology_types (
        name TEXT NOT NULL, version INTEGER NOT NULL, def TEXT NOT NULL,
        PRIMARY KEY (name, version));
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
        action TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
      INSERT INTO entities VALUES
        ('01OLDRECORD0000000000000A', 1, 'fact', 'verified',
         '{"statement":"knowledge from before the migration"}',
         '{"actor":"admin","origin":"cli","occurred_at":"2026-01-01T00:00:00Z"}',
         '2026-01-01T00:00:00Z');
    `);
    db.close();
    return path;
  }

  it("migrates it instead of dying on the column its own indexes need", async () => {
    const path = pre101();
    const store = new SqliteStorage(path);
    // This threw "no such column: ns" before the reorder — from `exec(SCHEMA)`, never reaching the
    // ALTER TABLE loop below it.
    await store.init();
    const cols = (store as unknown as { db: Database.Database }).db.pragma(
      "table_info(entities)",
    ) as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("ns");
    // And the indexes SCHEMA could not create now exist.
    const idx = (store as unknown as { db: Database.Database }).db
      .prepare(
        `SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%ns%'`,
      )
      .get() as { n: number };
    expect(idx.n).toBeGreaterThan(0);
    store.close();
  });

  it("keeps the knowledge that was already in it", async () => {
    const path = pre101();
    const store = new SqliteStorage(path);
    await store.init();
    const e = await store.getEntity("01OLDRECORD0000000000000A");
    expect(e?.attributes.statement).toBe("knowledge from before the migration");
    // A row that predates namespaces belongs to the default one — that is what the nullable column means.
    expect(e?.ns ?? null).toBeNull();
    store.close();
  });

  it("is idempotent, so a second open is not a second migration", async () => {
    const path = pre101();
    for (const _ of [1, 2]) {
      const store = new SqliteStorage(path);
      await store.init();
      expect(
        (await store.getEntity("01OLDRECORD0000000000000A"))?.version,
      ).toBe(1);
      store.close();
    }
  });
});

describe("a row and its indexes land together or not at all", () => {
  // putEntity ran four statements in autocommit — insert the version, read back the latest, drop the
  // FTS row, insert the new one. Anything ending the process between them left a durable state
  // nothing in the product can see or repair: present to `getEntity` and `listEntities`, absent from
  // `search` and therefore from every injection, with no command that rebuilds FTS.
  const prov = {
    actor: "tester",
    origin: "cli",
    occurred_at: "2026-08-14T00:00:00Z",
  };
  const row = (id: string) => ({
    id,
    type: "fact",
    attributes: { statement: `findable ${id}` },
    status: "verified" as const,
    version: 1,
    last_confirmed: "2026-08-14T00:00:00Z",
    provenance: prov,
  });

  it("rolls the entity row back when indexing it fails", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    // The vector write is the LAST statement in putEntity and the one that really throws:
    // `ensureVecTable` refuses a dimension change (deliberately — a silently dead vector half is the
    // worse failure). So this is the true window, entered after the version row and the FTS row are
    // already written.
    await store.putEntity({
      ...row("x0"),
      embedding: Float32Array.from([1, 0]),
    });
    await expect(
      store.putEntity({
        ...row("x1"),
        embedding: Float32Array.from([1, 0, 0, 0]),
      }),
    ).rejects.toThrow(/dimension/);
    // The version row must not have survived its own index write, and neither may its FTS row —
    // the state this guards is "present to getEntity, absent from search, no command to repair it".
    expect(await store.getEntity("x1")).toBeNull();
    expect((await store.listEntities({})).items.map((e) => e.id)).toEqual([
      "x0",
    ]);
    expect(await store.search({ text: "findable x1" })).toHaveLength(0);
    store.close();
  });

  it("leaves a written record findable by every read path", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    await store.putEntity(row("x2"));
    expect(await store.getEntity("x2")).not.toBeNull();
    expect((await store.listEntities({})).items).toHaveLength(1);
    expect(await store.search({ text: "findable" })).toHaveLength(1);
    store.close();
  });
});

// C6/F2: `entities_fts` was `fts5(id UNINDEXED, text)`, so `DELETE ... WHERE id = ?` (in putEntity and
// renameType) passed NO constraint to fts5 and scanned the whole index — O(N) per write, O(N^2) per
// bulk ingest, a 22 s rename lock-hold at 20k. The fix maps each id to its stable FTS rowid so the
// delete goes by rowid (O(log n)). These pin the STRUCTURE the speedup rests on; the numbers themselves
// are measured in the fts_docid schema note.
describe("FTS deletes by an indexed rowid, not a full scan (C6/F2)", () => {
  const prov = {
    actor: "tester",
    origin: "cli",
    occurred_at: "2026-08-14T00:00:00Z",
  };
  const ent = (id: string, version: number, note: string) => ({
    id,
    version,
    type: "fact",
    status: "verified" as const,
    attributes: { statement: note },
    provenance: prov,
    last_confirmed: "2026-08-14T00:00:00Z",
  });

  it("maps each id to one stable rowid and reuses it across re-versions", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const db = handleOf(store);
    await store.putEntity(ent("a", 1, "alpha one"));
    const first = db
      .prepare("SELECT docid FROM fts_docid WHERE id = 'a'")
      .get() as { docid: number } | undefined;
    expect(first, "a mapping is written on first insert").toBeTruthy();

    // Re-version several times — the rowid must NOT move and the FTS must not accumulate rows.
    await store.putEntity(ent("a", 2, "alpha two"));
    await store.putEntity(ent("a", 3, "alpha three"));
    const again = db
      .prepare("SELECT docid FROM fts_docid WHERE id = 'a'")
      .get() as { docid: number };
    expect(again.docid, "the rowid is stable across re-versions").toBe(
      first?.docid,
    );
    const ftsRows = db
      .prepare("SELECT rowid FROM entities_fts WHERE id = 'a'")
      .all() as { rowid: number }[];
    expect(ftsRows.map((r) => r.rowid)).toEqual([first?.docid]);

    // Search follows the latest version only — byte-identical semantics to the old scheme.
    expect((await store.search({ text: "three" })).map((e) => e.id)).toEqual([
      "a",
    ]);
    expect(await store.search({ text: "one" })).toEqual([]);

    // The delete the adapter now issues is a rowid equality lookup (constraint passed to fts5),
    // whereas delete-by-id passes none — the plan the O(N) scan used to take.
    const byRowid = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM entities_fts WHERE rowid = ?")
      .all(first?.docid)
      .map((r) => (r as { detail: string }).detail)
      .join(" ");
    const byId = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM entities_fts WHERE id = ?")
      .all("a")
      .map((r) => (r as { detail: string }).detail)
      .join(" ");
    expect(byRowid).toContain(":="); // fts5 got an equality constraint on the docid
    expect(byId).not.toContain(":="); // the old key gets none — a full scan
    store.close();
  });

  it("backfills the rowid map for a database that predates it, idempotently", async () => {
    // A pre-fix database: entities + FTS rows, but no fts_docid table. init() must create the map,
    // populate it once, keep search working, and let a later re-version delete by rowid.
    const path = join(dir, `ftsmig-${Math.random().toString(36).slice(2)}.db`);
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE entities (
        id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL, attributes TEXT NOT NULL, provenance TEXT NOT NULL,
        last_confirmed TEXT NOT NULL, PRIMARY KEY (id, version));
      CREATE VIRTUAL TABLE entities_fts USING fts5(id UNINDEXED, text);
      INSERT INTO entities VALUES
        ('old1', 1, 'fact', 'verified', '{"statement":"legacy alpha"}',
         '{"actor":"a","origin":"cli","occurred_at":"2026-01-01T00:00:00Z"}',
         '2026-01-01T00:00:00Z');
      INSERT INTO entities_fts (id, text) VALUES ('old1', 'fact {"statement":"legacy alpha"}');
    `);
    seed.close();

    const store = new SqliteStorage(path);
    await store.init();
    const db = handleOf(store);
    const mapped = db
      .prepare("SELECT docid FROM fts_docid WHERE id = 'old1'")
      .get() as { docid: number } | undefined;
    expect(mapped, "the pre-existing FTS row got a rowid mapping").toBeTruthy();
    expect((await store.search({ text: "legacy" })).map((e) => e.id)).toEqual([
      "old1",
    ]);

    // A re-version now reuses that backfilled rowid: one FTS row, latest text only.
    await store.putEntity({
      id: "old1",
      version: 2,
      type: "fact",
      status: "verified",
      attributes: { statement: "legacy beta" },
      provenance: prov,
      last_confirmed: "2026-01-01T00:00:00Z",
    });
    expect(
      (
        db.prepare("SELECT rowid FROM entities_fts WHERE id='old1'").all() as {
          rowid: number;
        }[]
      ).map((r) => r.rowid),
    ).toEqual([mapped?.docid]);
    expect((await store.search({ text: "beta" })).map((e) => e.id)).toEqual([
      "old1",
    ]);
    expect(await store.search({ text: "alpha" })).toEqual([]);
    store.close();

    // Idempotent: a second open does not re-run the backfill or duplicate the mapping.
    const reopened = new SqliteStorage(path);
    await reopened.init();
    const count = (
      handleOf(reopened)
        .prepare("SELECT count(*) AS n FROM fts_docid WHERE id='old1'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
    reopened.close();
  });
});

// C5: renameType and saveOntology used a DEFERRED `db.transaction()`, which opens as a reader and
// fails INSTANTLY (0 ms, before busy_timeout) when it upgrades to a writer under a concurrent writer.
// BEGIN IMMEDIATE requests the write lock up front, so it WAITS out busy_timeout instead of dying.
// Measured signal: deferred returns in ~0 ms, immediate in ~busy_timeout ms.
describe("governance writes wait for the write lock instead of dying instantly (C5)", () => {
  const prov = {
    actor: "yoke:system",
    origin: "cli",
    occurred_at: "2026-01-01T00:00:00Z",
  };
  const ent = (id: string, type: string) => ({
    id,
    version: 1,
    type,
    status: "verified" as const,
    attributes: { title: id },
    provenance: prov,
    last_confirmed: "2026-01-01T00:00:00Z",
  });
  const BUSY_MS = 300;

  /** Hold the write lock on one handle while a second handle attempts `op`; return how long `op` took
   * before it (inevitably) failed, since the lock is never released. Deferred dies at ~0; immediate
   * waits ~BUSY_MS. */
  async function heldWriteLock(op: (o: SqliteStorage) => Promise<unknown>) {
    const path = join(dir, `c5-${Math.random().toString(36).slice(2)}.db`);
    const holder = new SqliteStorage(path);
    await holder.init();
    await holder.saveOntology([{ name: "old", kind: "entity", attrs: {} }]);
    await holder.putEntity(ent("e", "old"));
    const other = new SqliteStorage(path);
    await other.init();
    handleOf(other).pragma(`busy_timeout = ${BUSY_MS}`);
    handleOf(holder).exec("BEGIN IMMEDIATE"); // hold the write lock, never commit
    handleOf(holder).prepare("UPDATE entities SET status = status").run();
    const t0 = Date.now();
    let failed = false;
    try {
      await op(other);
    } catch {
      failed = true;
    }
    const waited = Date.now() - t0;
    handleOf(holder).exec("ROLLBACK");
    holder.close();
    other.close();
    return { waited, failed };
  }

  it("renameType requests the lock up front (waits, not an instant snapshot failure)", async () => {
    const { waited, failed } = await heldWriteLock((o) =>
      o.renameType("old", "new"),
    );
    expect(failed).toBe(true); // the lock is never released, so it does time out
    // The point: it WAITED for the lock (immediate) instead of dying at ~0 ms (the deferred upgrade).
    expect(waited).toBeGreaterThanOrEqual(BUSY_MS - 80);
  });

  it("saveOntology requests the lock up front too", async () => {
    const { waited, failed } = await heldWriteLock((o) =>
      o.saveOntology([{ name: "another", kind: "entity", attrs: {} }]),
    );
    expect(failed).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(BUSY_MS - 80);
  });
});
