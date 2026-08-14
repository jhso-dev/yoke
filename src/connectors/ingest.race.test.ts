// C4 regression — concurrent ingest of one source item must yield ONE record. Reproduced through the
// honest topology the defect lives in: TWO PROCESSES on one database file (two cron jobs on one
// directory), not two handles in a single thread — better-sqlite3's blocking write-lock would deadlock
// those, and the production shape is separate processes anyway. Each child ingests the same
// external_id; the parent seeds and then counts.
//
// Before the fix: findByExternalId (an FTS read) then commit ran unserialized, so both children read
// "absent" and both committed — the corpus held the item TWICE (measured: 6 notes -> 7 records), no
// supersedes, exit 0. The withCriticalSection serialization makes the second child see the first's row.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { seedOntology } from "../core/ontology.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-ingest-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHILD = join(process.cwd(), "scripts", "ingest-race-child.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const EXTERNAL_ID = "file:race#0";

describe("two concurrent ingests of one source item (C4)", () => {
  it("store exactly one record for the shared external_id", async () => {
    const path = join(dir, `race-${Math.random().toString(36).slice(2)}.db`);
    // Seed schema + ontology in-process so the children only race the ingest.
    const seed = new SqliteStorage(path);
    await seed.init();
    await seed.saveOntology(seedOntology());
    seed.close();

    const run = (dbPath: string, actor: string) =>
      new Promise<{ code: number; err: string }>((resolve) => {
        let err = "";
        const c = spawn(TSX, [CHILD, dbPath, actor], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        c.stderr.on("data", (d) => {
          err += d;
        });
        c.on("exit", (code) => resolve({ code: code ?? 1, err }));
      });

    // Warm tsx's transform cache on a throwaway DB FIRST. Two tsx processes started at once otherwise
    // race each other transforming the same source files (an esm-loader import error, unrelated to the
    // DB race under test); a sequential warm-up populates the cache so the racers only contend on the
    // write lock, which is the thing being tested.
    const warm = join(dir, `warm-${Math.random().toString(36).slice(2)}.db`);
    const w = new SqliteStorage(warm);
    await w.init();
    await w.saveOntology(seedOntology());
    w.close();
    await run(warm, "warmup");

    // Now launch both racers as close together as possible and await both.
    const [ca, cb] = await Promise.all([run(path, "A"), run(path, "B")]);
    expect(ca.code, `child A failed: ${ca.err}`).toBe(0);
    expect(cb.code, `child B failed: ${cb.err}`).toBe(0);

    const store = new SqliteStorage(path);
    await store.init();
    const page = await store.listEntities({ type: "fact" });
    const records = page.items.filter(
      (e) => e.attributes.external_id === EXTERNAL_ID,
    );
    store.close();
    expect(
      records.length,
      "concurrent ingests of one source item must serialize to a single record",
    ).toBe(1);
  }, 30_000);
});
