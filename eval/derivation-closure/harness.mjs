#!/usr/bin/env node
// Transitive-closure measurement harness.
//
// Question: on realistic derivation corpora, what does each reporting mechanism reach, judged
// against a SEMANTIC ground truth (which records a steward should actually re-examine)?
//
//   one-hop    what `yoke deprecate` reports today (via the real CLI, --json)
//   iterative  one-hop, then the "human" retires exactly the ground-truth-invalidated records among
//              what was reported, repeat to fixpoint — the workflow the current design assumes
//   closure    full transitive closure over derived_from (what the proposed feature would report)
//
// Metrics per event: recall on invalidated GT, recall on all-reexamine GT, noise (reported but GT
// says unaffected), report sizes, rounds; plus unreachable GT (no graph path — no mechanism helps).
//
//   node harness.mjs corpus-a.json

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteStorage } from "../../dist/adapters/storage-sqlite/index.js";
import { commit } from "../../dist/core/commit.js";
import { deprecate, downstreamOf, verify } from "../../dist/core/lifecycle.js";
import { seedOntology } from "../../dist/core/ontology.js";

const CLI = fileURLToPath(
  new URL("../../dist/front/cli/index.js", import.meta.url),
);
const NOW = "2026-08-07T09:00:00.000Z";
const corpusPath = process.argv[2];
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const base = corpusPath.replace(/\.json$/, ".db");

// ---- build the corpus through the real gate ----
for (const f of [base, `${base}-wal`, `${base}-shm`])
  rmSync(f, { force: true });
const store = new SqliteStorage(base);
await store.init();
const ontology = seedOntology();
await store.saveOntology(ontology);
const prov = { actor: "steward", origin: "cli", occurred_at: NOW };

const idOf = new Map(); // key -> real id
const ids = [];
for (const r of corpus.records) {
  const attrs =
    r.type === "fact"
      ? { statement: r.statement }
      : { conclusion: r.conclusion, rationale: r.rationale };
  const { entity } = await commit(
    store,
    ontology,
    { type: r.type, attributes: attrs },
    prov,
    NOW,
  );
  idOf.set(r.key, entity.id);
  ids.push(entity.id);
  for (const dep of r.derived_from ?? []) {
    if (!idOf.has(dep))
      throw new Error(`${r.key} cites ${dep} before it exists`);
    await commit(
      store,
      ontology,
      {
        type: "derived_from",
        attributes: {},
        from: entity.id,
        to: idOf.get(dep),
      },
      prov,
      NOW,
    );
  }
}
await verify(store, ids, "steward", NOW);

// ---- corpus stats: edges, depth, in-degree ----
const keyOf = new Map([...idOf].map(([k, v]) => [v, k]));
const parents = new Map(); // key -> basis keys
for (const r of corpus.records) parents.set(r.key, r.derived_from ?? []);
const depth = new Map();
const depthOf = (k) => {
  if (depth.has(k)) return depth.get(k);
  const ps = parents.get(k) ?? [];
  const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depthOf));
  depth.set(k, d);
  return d;
};
for (const r of corpus.records) depthOf(r.key);
const edges = corpus.records.reduce(
  (n, r) => n + (r.derived_from?.length ?? 0),
  0,
);
const withBasis = corpus.records.filter((r) => r.derived_from?.length).length;
const maxDepth = Math.max(...depth.values());

// children index for closure
const children = new Map(); // key -> dependent keys
for (const r of corpus.records)
  for (const p of r.derived_from ?? []) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(r.key);
  }
const closureOf = (root) => {
  const seen = new Set();
  const q = [root];
  while (q.length) {
    for (const c of children.get(q.shift()) ?? [])
      if (!seen.has(c)) {
        seen.add(c);
        q.push(c);
      }
  }
  return seen;
};

store.close();

// ---- events ----
const results = [];
for (const ev of corpus.events) {
  const db = `${base}.ev.db`;
  rmSync(db, { force: true });
  copyFileSync(base, db);
  const rootId = idOf.get(ev.deprecate);

  // one-hop: the real CLI's report
  const out = JSON.parse(
    execFileSync("node", [CLI, "deprecate", rootId, "--db", db, "--json"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .at(-1),
  );
  const hop1 = new Set(out.downstream.map((e) => keyOf.get(e.id)));

  // ground truth
  const gtInv = new Set(
    ev.reexamine.filter((x) => x.verdict === "invalidated").map((x) => x.key),
  );
  const gtAll = new Set(ev.reexamine.map((x) => x.key));

  // iterative: retire GT-invalidated among reported, re-run downstreamOf on the new retirees
  const s2 = new SqliteStorage(db);
  await s2.init();
  const reached = new Set(hop1);
  let frontier = [...hop1].filter((k) => gtInv.has(k));
  const retired = new Set(frontier);
  let rounds = 1;
  while (frontier.length) {
    await deprecate(
      s2,
      frontier.map((k) => idOf.get(k)),
      "steward",
      NOW,
    );
    const next = new Set();
    for (const e of await downstreamOf(
      s2,
      frontier.map((k) => idOf.get(k)),
    ))
      next.add(keyOf.get(e.id));
    rounds++;
    frontier = [...next].filter((k) => !reached.has(k) && gtInv.has(k));
    for (const k of next) reached.add(k);
    for (const k of frontier) retired.add(k);
  }
  s2.close();

  const clo = closureOf(ev.deprecate);
  const m = (set) => ({
    recallInv: gtInv.size
      ? [...gtInv].filter((k) => set.has(k)).length / gtInv.size
      : 1,
    recallAll: gtAll.size
      ? [...gtAll].filter((k) => set.has(k)).length / gtAll.size
      : 1,
    noise: [...set].filter((k) => !gtAll.has(k)).length,
    size: set.size,
  });
  results.push({
    event: ev.deprecate,
    why: ev.why,
    gt: { invalidated: gtInv.size, reexamine: gtAll.size },
    unreachable: [...gtAll].filter((k) => !clo.has(k)),
    hop1: m(hop1),
    iterative: { ...m(reached), rounds },
    closure: m(clo),
  });
  rmSync(db, { force: true });
}

console.log(
  JSON.stringify(
    {
      domain: corpus.domain,
      stats: {
        records: corpus.records.length,
        withBasis,
        edges,
        maxDepth,
        depthHistogram: [...depth.values()].reduce((h, d) => {
          h[d] = (h[d] ?? 0) + 1;
          return h;
        }, {}),
      },
      results,
    },
    null,
    1,
  ),
);
