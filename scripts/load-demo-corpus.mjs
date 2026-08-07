#!/usr/bin/env node
// Load the demo corpus (scripts/demo-corpus/) through the same commit gate and the same `openStore`
// path a person or an agent uses. **Nothing here is backend-specific** — the only difference between
// loading into sqlite and loading into OpenSearch is which environment variable is set, which is what
// makes this evidence that the port abstraction holds rather than each adapter having its own ingest
// route.
//
//   node scripts/load-demo-corpus.mjs [local.db]
//
//   (nothing set)            everything into that one sqlite file
//   YOKE_OPENSEARCH_URL=...  knowledge into OpenSearch, this client's audit + tokens into the sqlite file
//   YOKE_EMBED_URL=...       optional; without it the corpus loads with no vectors, which is a
//                            complete corpus (SPEC "The vector index") minus the hybrid half of
//                            retrieval. The load says which of the two it did.
//
// Three record shapes, all written by the same seed authors — see scripts/demo-corpus/README.md:
//   records[]     the base corpus (10 departments x 26)
//   aged[]        knowledge that was true a while ago. `age_days` puts last_confirmed in the past, so
//                 the stale queue has real content rather than a synthetic timestamp
//   conflicts[]   PAIRS that genuinely contradict, linked conflicts_with, for the conflicts screen

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commit } from "../dist/core/commit.js";
import { makeFetchEmbedder } from "../dist/core/embedding.js";
import { deprecate, verify } from "../dist/core/lifecycle.js";
import { seedOntology } from "../dist/core/ontology.js";
import { openStore } from "../dist/front/store.js";

const DIR = fileURLToPath(new URL("demo-corpus", import.meta.url));
const LOCAL = process.argv[2] ?? "./demo-yoke.db";
const NOW = "2026-08-04T09:00:00.000Z";
const DAY = 86400000;
const iso = (daysAgo) =>
  new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();

/** Deterministic spread of occurred_at. No Math.random: a reload must produce the same corpus, or
 * "it changed" stops being evidence of anything. */
const dateFor = (key) => {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return iso(h % 400);
};

// The local sqlite is bookkeeping (audit + tokens) and is rebuilt from scratch. A remote knowledge
// store is NOT cleared here — erasing someone's database as a side effect of a demo load is not this
// script's decision to make. Point it at an empty database, or use its own tooling first.
for (const s of ["", "-wal", "-shm"]) rmSync(LOCAL + s, { force: true });

const files = readdirSync(DIR)
  .filter((f) => /^([0-9]{2}|a[0-9])-.*\.json$/.test(f))
  .sort();
const domains = files.map((f) => ({
  file: f,
  ...JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")),
}));

const embedder = makeFetchEmbedder(process.env);
const vectors = (await embedder("probe")) !== null;
console.log(
  vectors
    ? `embedder: ${process.env.YOKE_EMBED_MODEL} — vectors on`
    : "embedder: none — loading WITHOUT vectors (set YOKE_EMBED_URL for hybrid retrieval)",
);

const store = await openStore({ db: LOCAL }, process.env);
await store.init();
const ontology = seedOntology();
await store.saveOntology(ontology);

// The bootstrap actor, which `yoke init` normally seeds. Without it `yoke mcp` refuses the database
// outright ("not initialized") — so the corpus loaded here was readable by the CLI and the web UI and
// unusable over the one interface the product exists to serve. Found by pointing a real MCP client at
// it. Idempotent: skipped when the row is already there, so re-running the loader is still safe.
if (!(await store.getEntity("yoke:system"))) {
  const at = "2025-01-01T00:00:00.000Z";
  const { entity } = await commit(
    store,
    ontology,
    { type: "person", attributes: { name: "yoke" } },
    { actor: "yoke:system", origin: "seed", occurred_at: at },
    at,
    { existingId: "yoke:system" },
  );
  await verify(store, [entity.id], "yoke:system", at);
}

const add = async (input, actor, at, existingId) => {
  const { entity } = await commit(
    store,
    ontology,
    input,
    { actor, origin: "seed", occurred_at: at },
    at,
    { embedder, existingId },
  );
  return entity.id;
};
const rel = (type, from, to, actor, at) =>
  add({ type, attributes: {}, from, to }, actor, at);

const c = {
  people: 0,
  collab: 0,
  records: 0,
  aged: 0,
  conflictPairs: 0,
  relations: 0,
  draft: 0,
  stale: 0,
  deprecated: 0,
};

await add(
  {
    type: "person",
    attributes: {
      name: "지식 관리자",
      role: "Knowledge Steward",
      team: "Engineering Enablement",
    },
  },
  "person:steward",
  NOW,
  "person:steward",
);

// --- roster and anchors first: everything else points at them ---
for (const d of domains.filter((x) => x.collaboration)) {
  await add(
    { type: "collaboration", attributes: { title: d.collaboration.title } },
    "person:steward",
    NOW,
    d.collaboration.id,
  );
  c.collab++;
  for (const p of d.people) {
    await add(
      {
        type: "person",
        attributes: { name: p.name, role: p.role, team: p.team },
      },
      "person:steward",
      NOW,
      p.id,
    );
    await rel("works_on", p.id, d.collaboration.id, p.id, NOW);
    c.people++;
    c.relations++;
  }
}

const byKey = new Map();

// --- the base corpus ---
for (const d of domains.filter((x) => x.records)) {
  for (const r of d.records) {
    const at = r.state === "stale" ? iso(330) : dateFor(r.key);
    const id = await add(
      { type: r.type, attributes: r.attributes },
      r.author,
      at,
    );
    byKey.set(`${d.file}#${r.key}`, id);
    c.records++;
    // Confirmed by the AUTHOR, not by a steward. `verify` replaces provenance, so confirming
    // everything as one reviewer would erase every author and point the stale queue's owner routing
    // (it reads provenance.actor) at that one person. Learned by doing it wrong on a live corpus.
    if (r.state === "verified") await verify(store, [id], r.author, NOW);
    else if (r.state === "stale") {
      await verify(store, [id], r.author, iso(330));
      c.stale++;
    } else c.draft++;
    await rel("relates_to", id, d.collaboration.id, r.author, at);
    c.relations++;
  }
  for (const l of d.links ?? []) {
    const from = byKey.get(`${d.file}#${l.from}`);
    const to = byKey.get(`${d.file}#${l.to}`);
    if (!from || !to) continue;
    await rel(l.type, from, to, "person:steward", NOW);
    c.relations++;
    if (l.type === "supersedes") {
      await deprecate(store, [to], "person:steward", NOW);
      c.deprecated++;
    }
  }
  console.log(`  ${d.file}: ${d.records.length} records`);
}

// --- aged: confirmed in the past, so effectiveStatus computes `stale` at read time ---
for (const d of domains.filter((x) => x.aged)) {
  for (const r of d.aged) {
    const at = iso(r.age_days + 10);
    const id = await add(
      { type: r.type, attributes: r.attributes },
      r.author,
      at,
    );
    // Confirmed AT that time, by its author. `fact` expires after 180 days and `decision` after 365,
    // so whether a given row is stale today is the ontology's arithmetic, not a flag set here.
    await verify(store, [id], r.author, iso(r.age_days));
    if (r.collab) {
      await rel("relates_to", id, r.collab, r.author, at);
      c.relations++;
    }
    c.aged++;
  }
  console.log(`  ${d.file}: ${d.aged.length} aged`);
}

// --- conflicts: both sides verified, linked conflicts_with, neither resolved ---
for (const d of domains.filter((x) => x.conflicts)) {
  for (const pair of d.conflicts) {
    const ids = [];
    for (const side of [pair.a, pair.b]) {
      const at = iso((side.age_days ?? 30) + 5);
      const id = await add(
        { type: side.type, attributes: side.attributes },
        side.author,
        at,
      );
      await verify(store, [id], side.author, iso(side.age_days ?? 30));
      if (side.collab) {
        await rel("relates_to", id, side.collab, side.author, at);
        c.relations++;
      }
      ids.push(id);
    }
    // The contradiction itself is knowledge: yoke keeps both sides and does not decide.
    await rel("conflicts_with", ids[0], ids[1], "person:steward", NOW);
    c.relations++;
    c.conflictPairs++;
  }
  console.log(`  ${d.file}: ${d.conflicts.length} conflict pairs`);
}

// --- cross-domain edges, so this is one graph rather than ten stars ---
let cross = 0;
const withRecords = domains.filter((x) => x.records);
for (let i = 0; i < withRecords.length; i++) {
  const a = withRecords[i];
  const b = withRecords[(i + 1) % withRecords.length];
  const big = (d) => d.records.find((r) => r.size === "a4") ?? d.records[0];
  const from = byKey.get(`${a.file}#${big(a).key}`);
  const to = byKey.get(`${b.file}#${big(b).key}`);
  if (from && to) {
    await rel("relates_to", from, to, "person:steward", NOW);
    cross++;
  }
  await rel(
    "works_on",
    a.people[0].id,
    b.collaboration.id,
    a.people[0].id,
    NOW,
  );
  cross++;
}
c.relations += cross;

// The roster and the anchors are not knowledge under review — leaving them draft would put 41 rows in
// the review queue that nobody is meant to act on.
for (const type of ["person", "collaboration"]) {
  const { items } = await store.listEntities({
    type,
    status: "draft",
    limit: 500,
  });
  await verify(
    store,
    items.map((e) => e.id),
    "person:steward",
    NOW,
  );
}

const token = store.createToken({
  name: "admin",
  scopes: ["read", "write", "verify"],
  created_at: NOW,
}).token;
store.close();
console.log(
  `\n${JSON.stringify({ ...c, cross, vectors, token, local: LOCAL }, null, 2)}`,
);
