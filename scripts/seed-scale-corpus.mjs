#!/usr/bin/env node
// Bulk-seed a corpus large enough to measure the shipped read paths against (docs/SCALE.md).
//
//   npm run build
//   node scripts/seed-scale-corpus.mjs ./big1m.db 1000000 3000000
//
// Why this is in the repo. docs/SCALE.md's numbers — 10k / 100k / 1M / 10M entities, 3M relations,
// the five defects they exposed — were produced by a generator that lived only in a scratch directory.
// The measurements were therefore documented and unreproducible, which is the same gap the demo corpus
// had until v5.5 promoted it here, and the same reasoning: a benchmark nobody can re-run is a claim,
// not a measurement.
//
// It is NOT the demo corpus and cannot replace it. Every record is built from one sentence skeleton, so
// 0 of 676 pairs are semantically related while lexically different (docs/RESEARCH.md) and retrieval
// quality is invisible against it. Use `scripts/load-demo-corpus.mjs` when the corpus is what is under
// test; use this when you need rows.
//
// It bypasses the commit gate on purpose — a million records through `commit` is hours, and the point
// is to load the READ paths, not to exercise the write path. Two consequences, both deliberate:
// there is no authorship edge and no duplicate detection here, so a corpus from this script is not
// suitable for measuring anything that walks `authored_by`.

import Database from "better-sqlite3";
import { SqliteStorage } from "../dist/adapters/storage-sqlite/index.js";
import { seedOntology } from "../dist/core/ontology.js";

const [, , path, nStr, eStr] = process.argv;
if (!path || !nStr) {
  console.error(
    "usage: node scripts/seed-scale-corpus.mjs <db> <entities> [relations]",
  );
  process.exit(2);
}
const N = Number(nStr);
const E = Number(eStr ?? 0);

// The schema comes from the ADAPTER, not from a copy pasted in here. The scratch version of this script
// carried its own CREATE TABLE block and it had already drifted: no indexes (so every measurement it
// fed was of an unindexed database) and no tokens table. Anything the adapter adds later arrives here
// for free.
const store = new SqliteStorage(path);
await store.init();
await store.saveOntology(seedOntology());
store.close();

const db = new Database(path);
db.pragma("journal_mode = WAL");

/** Deterministic 26-char ULID-shaped ids: lexicographic order is creation order, which is what the
 * keyset cursor contract assumes. `prefix` separates the entity and relation id spaces. */
const C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const id26 = (n, prefix = "01KZ000000000") => {
  let x = n;
  let t = "";
  for (let i = 0; i < 13; i++) {
    t = C[x % 32] + t;
    x = Math.floor(x / 32);
  }
  return prefix + t;
};

const prov = JSON.stringify({
  actor: "seed",
  origin: "cli",
  occurred_at: "2026-07-01T00:00:00Z",
});
const AT = "2026-07-01T00:00:00Z";

// A status mix rather than all-verified: injection filters on effective status, so a corpus of
// nothing but verified records cannot show what the filter costs (SCALE.md's "asked for 50, received
// 29" was found this way). Roughly 70/15/15 verified/draft/deprecated.
const statusOf = (i) =>
  i % 20 < 14 ? "verified" : i % 20 < 17 ? "draft" : "deprecated";

const insE = db.prepare(
  `INSERT OR IGNORE INTO entities
     (id, version, type, status, attributes, provenance, last_confirmed, ns)
   VALUES (?, 1, ?, ?, ?, ?, ?, NULL)`,
);
const insF = db.prepare("INSERT INTO entities_fts (id, text) VALUES (?, ?)");

const t0 = Date.now();
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    // One skeleton, three selectivities: every record carries "system", ~1% carry "rollout", ~0.01%
    // carry "quorum". That is what makes a ranking cost curve measurable at all.
    const note =
      `system record ${i}` +
      (i % 100 === 0 ? " rollout" : "") +
      (i % 10000 === 0 ? " quorum" : "");
    const attrs = JSON.stringify({ note });
    const id = id26(i);
    insE.run(id, "fact", statusOf(i), attrs, prov, AT);
    // The FTS row is written by the adapter on every putEntity, so a corpus without it would make
    // `search` return nothing and every retrieval measurement meaningless.
    insF.run(id, `fact ${attrs}`);
  }
})();
const entSec = ((Date.now() - t0) / 1000).toFixed(1);

let relSec = "0";
if (E > 0) {
  const insR = db.prepare(
    `INSERT OR IGNORE INTO relations
       (id, version, type, status, attributes, provenance, last_confirmed, ns, from_id, to_id)
     VALUES (?, 1, ?, 'verified', '{}', ?, ?, NULL, ?, ?)`,
  );
  const TYPES = ["relates_to", "supersedes", "conflicts_with", "authored_by"];
  const t1 = Date.now();
  db.transaction(() => {
    for (let i = 0; i < E; i++) {
      // 7919 is prime, so the edges spread rather than clustering on low ids.
      insR.run(
        id26(i, "01KZ111111111"),
        TYPES[i % 4],
        prov,
        AT,
        id26(i % N),
        id26((i * 7919 + 13) % N),
      );
    }
    // One high-degree anchor, because that is the shape the briefing path walks and the shape that
    // made `neighbors` cost the same for a node with three edges as for one with five thousand.
    const anchor = id26(0);
    for (let i = 0; i < 5000; i++) {
      insR.run(
        id26(i, "01KZ222222222"),
        "relates_to",
        prov,
        AT,
        id26((i * 31 + 1) % N),
        anchor,
      );
    }
  })();
  relSec = ((Date.now() - t1) / 1000).toFixed(1);
}

console.log(
  JSON.stringify(
    {
      db: path,
      entities: db.prepare("SELECT count(*) c FROM entities").get().c,
      relations: db.prepare("SELECT count(*) c FROM relations").get().c,
      entitySeconds: +entSec,
      relationSeconds: +relSec,
    },
    null,
    2,
  ),
);
db.close();
