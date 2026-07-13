// storage-sqlite tests — run the conformance suite against both :memory: and a temp file,
// and check the ontology save/load round-trip.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
