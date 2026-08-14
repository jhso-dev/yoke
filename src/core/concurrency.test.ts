// Concurrency regression tests — the version-race defects (C1/C2), reproduced through the REAL
// surface: two SqliteStorage handles on one database file (the everyday `yoke mcp` + `yoke ui` + CLI
// shape), not a mock. better-sqlite3 sets busy_timeout=5000 and WAL, so these are not "instant
// SQLITE_BUSY" — they survive the timeout. Each defect surfaced a raw `UNIQUE constraint failed` to the
// user (C1) or half-applied a batch while reporting total failure (C2).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { verify } from "./lifecycle.js";
import { seedOntology } from "./ontology.js";
import type { Provenance } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-concurrency-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ont = seedOntology();
const now = "2026-08-14T00:00:00Z";
const prov: Provenance = {
  actor: "yoke:system",
  origin: "cli",
  occurred_at: "2026-08-14T00:00:00Z",
};

/** Two handles on one file — two processes, in effect. The first seeds the schema + ontology. */
async function twoHandles(): Promise<[SqliteStorage, SqliteStorage, string]> {
  const path = join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  const a = new SqliteStorage(path);
  await a.init();
  await a.saveOntology(seedOntology());
  const b = new SqliteStorage(path);
  await b.init();
  return [a, b, path];
}

describe("concurrent re-version of one id (C1)", () => {
  it("both writers land on distinct versions, none sees a raw UNIQUE error", async () => {
    const [a, b] = await twoHandles();
    const base = await commit(
      a,
      ont,
      { type: "fact", attributes: { statement: "base claim" } },
      prov,
      now,
    );
    const id = base.entity.id;

    // Two processes re-version the SAME id at once. Both read prev=v1 and compute version 2; one wins
    // the (id, version) primary key and the other used to throw `UNIQUE constraint failed: entities.id,
    // entities.version` straight to the caller. With the typed ConflictError + bounded retry, the loser
    // re-reads and re-versions, so both land — serialized — on versions 2 and 3.
    const [r1, r2] = await Promise.all([
      commit(
        a,
        ont,
        { type: "fact", attributes: { statement: "edit A" } },
        prov,
        now,
        { existingId: id },
      ),
      commit(
        b,
        ont,
        { type: "fact", attributes: { statement: "edit B" } },
        prov,
        now,
        { existingId: id },
      ),
    ]);

    expect([r1.entity.version, r2.entity.version].sort()).toEqual([2, 3]);
    // History is a dense, gap-free chain — the append-only contract held under the race.
    expect(a.listHistory(id).map((e) => e.version)).toEqual([1, 2, 3]);
    a.close();
    b.close();
  });
});

describe("concurrent promotion of a batch (C2)", () => {
  it("does not half-apply: both callers get every id, neither reports whole-batch failure", async () => {
    const [a, b] = await twoHandles();
    const ids: string[] = [];
    for (const s of ["one", "two", "three"]) {
      const c = await commit(
        a,
        ont,
        { type: "fact", attributes: { statement: s } },
        prov,
        now,
      );
      ids.push(c.entity.id);
    }

    // Two processes verify the WHOLE batch at once. Without serialization the loser's putEntity threw
    // MID-loop — earlier ids already promoted, the caller told the batch failed (the exact state the
    // two-loop design claims to prevent). With the retry, both calls promote every id.
    const [ra, rb] = await Promise.all([
      verify(a, ids, "alice", now),
      verify(b, ids, "bob", now),
    ]);

    expect(ra.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(rb.map((e) => e.id).sort()).toEqual([...ids].sort());
    // Every record ended verified, and each id's history is a dense chain (no gap, no half-applied hole).
    for (const id of ids) {
      const versions = a.listHistory(id).map((e) => e.version);
      expect(versions).toEqual(
        Array.from({ length: versions.length }, (_, i) => i + 1),
      );
      expect(a.listHistory(id).at(-1)?.status).toBe("verified");
    }
    a.close();
    b.close();
  });
});
