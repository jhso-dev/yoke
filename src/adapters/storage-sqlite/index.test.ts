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

describe("ontology save/load", () => {
  it("round-trips the seed ontology", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    const seed = seedOntology();
    store.saveOntology(seed);
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
    // Namespace isolation: an audit viewer must not show one tenant's queries to another, and the
    // default namespace is not a wildcard over tenants.
    expect(store.listAudit({ ns: "acme" })).toEqual([tenant]);
    expect(store.listAudit({ ns: "globex" })).toEqual([]);
    // limit takes the most recent N but still returns them oldest-first.
    expect(store.listAudit({ limit: 1 })).toEqual([b]);
    expect(store.listAudit({ limit: 5 })).toEqual([a, b]);
    // `at >= since` is a TEXT compare, so `since` must be the same ISO shape the rows are written in.
    // Every writer uses `new Date().toISOString()`, i.e. milliseconds — and a second-precision `since`
    // sorts AFTER a row inside its own second (`Z` > `.`), silently dropping it. A caller building
    // `since` by hand is the one who would trip on this, so it is pinned here rather than assumed.
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
    expect(store.listAudit({ since: "2026-04-01T00:00:00Z" })).toEqual([]);
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
    store.saveOntology([
      { name: "old", kind: "entity", attrs: {} },
      { name: "fact", kind: "entity", attrs: {} },
    ]);
    await store.putEntity(ent("e1", "old"));
    await store.putEntity(ent("e1", "old", 2));
    await store.putEntity(ent("keep", "fact"));

    expect(store.renameType("old", "new")).toBe(3); // 2 versions + 1 declaration

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
    expect(store.renameType("works_on", "assigned_to")).toBe(1);
    expect((await store.neighbors("a")).map((r) => r.type)).toEqual([
      "assigned_to",
    ]);

    // One tenant renaming does not touch another's rows — the same guarantee every other query has.
    await store.putEntity(ent("t1", "shared", 1, "acme"));
    await store.putEntity(ent("t2", "shared", 1, "globex"));
    expect(store.renameType("shared", "common", "acme")).toBe(1);
    expect((await store.getEntity("t1"))?.type).toBe("common");
    expect((await store.getEntity("t2"))?.type).toBe("shared");
    store.close();
  });

  it("drops the stale declaration when the new name is already declared", async () => {
    // The ordinary case: the code was renamed first, so a later `yoke init` seeded the new type
    // beside the old one. Rewriting the old row's name would collide with the live one.
    const store = new SqliteStorage(":memory:");
    await store.init();
    store.saveOntology([{ name: "old", kind: "entity", attrs: {} }]);
    store.saveOntology([{ name: "new", kind: "entity", attrs: {} }]);
    await store.putEntity(ent("e", "old"));
    expect(store.renameType("old", "new")).toBe(2); // 1 version + 1 dropped declaration
    expect(store.loadOntology().map((d) => d.name)).toEqual(["new"]);
    expect((await store.getEntity("e"))?.type).toBe("new");
    store.close();
  });

  it("reports zero rather than failing when nothing carries the name", async () => {
    const store = new SqliteStorage(":memory:");
    await store.init();
    expect(store.renameType("absent", "whatever")).toBe(0);
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
    store.saveOntology(seedOntology());
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
    store.saveOntology(seedOntology());
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
