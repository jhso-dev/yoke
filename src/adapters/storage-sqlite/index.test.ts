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
    store.logAudit(a);
    store.logAudit(b);
    expect(store.listAudit()).toEqual([a, b]);
    expect(store.listAudit("2026-01-15T00:00:00Z")).toEqual([b]);
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
