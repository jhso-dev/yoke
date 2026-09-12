// Persona-quality eval (MARKET strategy 6 "prove it with measurement", same family as inject-quality).
// A runnable script, not a vitest suite — the numbers are the deliverable.
// Run: npm run eval:persona  (tsx eval/persona-quality.ts)
//
// A persona is a person-anchored injection of THAT person's verified records (SPEC "persona").
// Everything that can go wrong with one is a form of misattribution or leakage, so this measures the
// four failure modes against a corpus deliberately full of bait:
//
//   1) Impersonation rate — records returned by persona(A) that A did not author (target 0%), and
//      records A DID author that are not knowledge at all: the collaboration they started, the person
//      record filed for a colleague. This axis was missing and the gap was real — the bait below was
//      all about AUTHORSHIP, so a corpus where the subject creates their own collaboration passed
//      while the persona listed a project name among the things that person knows.
//      Bait: B's verified records on the SAME topics as A's, plus records linked to A by
//      `relates_to` (an association is not authorship), plus facts A's own decisions cite via
//      `derived_from` but which someone else wrote — the depth-2 vector the graph's shape is
//      supposed to make unreachable.
//   2) Draft-leak rate — A's own unverified records returned (target 0%). A draft judgment presented
//      as someone's judgment is the gate's whole promise broken at its most personal surface.
//   3) Stale-leak rate — A's verified-but-aged records returned (target 0%). Freshness is computed
//      at read time; a persona quoting an expired position misrepresents the person today.
//   4) Recall — A's verified, fresh records that persona(A) actually returns (target 100%), whole
//      and under a topic query. A persona that silently drops half of someone's judgment is the
//      other way to misrepresent them.
//
// No number-fudging — if the anchor walk or the filters regress, the numbers say so and the exit
// code goes non-zero.

import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { commit } from "../src/core/commit.js";
import { verify } from "../src/core/lifecycle.js";
import { seedOntology } from "../src/core/ontology.js";
import { personaQuery } from "../src/core/persona.js";
import type { Provenance } from "../src/core/types.js";

const NOW = "2026-08-10T00:00:00Z";
const LONG_AGO = "2025-08-10T00:00:00Z"; // > fact's 180-day TTL and > decision's 365-day TTL is not needed — facts age first
const prov = (actor: string, at = NOW): Provenance => ({
  actor,
  origin: "cli",
  occurred_at: at,
});

// Distinct topic tokens with no prefix relationship (the inject-quality rule): every record of a
// topic contains its token, so a topic query has an unambiguous gold set.
const TOPICS = [
  "settlement",
  "webhook",
  "ledger",
  "timeout",
  "partition",
  "archive",
  "rollout",
  "flagging",
  "quorum",
  "checkpoint",
];

async function run() {
  const store = new SqliteStorage(":memory:");
  await store.init();
  const ontology = seedOntology();
  await store.saveOntology(ontology);

  // Two people. Alice is the persona under test; Bob is the bait author.
  const alice = (
    await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "Alice" } },
      prov("eval:seed"),
      NOW,
    )
  ).entity.id;
  const bob = (
    await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "Bob" } },
      prov("eval:seed"),
      NOW,
    )
  ).entity.id;

  const record = async (
    actor: string,
    topic: string,
    kind: "decision" | "fact",
    opts?: { at?: string; verified?: boolean },
  ) => {
    const at = opts?.at ?? NOW;
    const { entity } = await commit(
      store,
      ontology,
      kind === "decision"
        ? {
            type: "decision",
            attributes: {
              conclusion: `${topic} handling stays as decided`,
              rationale: `the ${topic} constraint is real`,
            },
          }
        : {
            type: "fact",
            attributes: { statement: `the ${topic} limit is measured` },
          },
      prov(actor, at),
      at,
    );
    if (opts?.verified !== false) await verify(store, [entity.id], actor, at);
    return entity.id;
  };
  const link = (type: string, from: string, to: string) =>
    commit(
      store,
      ontology,
      { type, attributes: {}, from, to },
      prov("eval:seed"),
      NOW,
    );

  // ---- Alice's gold set: one verified fresh decision per topic. ----
  const gold: string[] = [];
  for (const t of TOPICS) gold.push(await record(alice, t, "decision"));

  // ---- Bait, one of each per topic. None of it may surface in persona(alice). ----
  const bait = {
    otherAuthor: [] as string[], // Bob's verified records, same topics
    related: [] as string[], // Bob's records linked to ALICE via relates_to — association, not authorship
    derivedSource: [] as string[], // Bob's facts that Alice's decisions REST ON (derived_from, depth 2)
    aliceDraft: [] as string[], // Alice's own drafts
    aliceStale: [] as string[], // Alice's own verified-but-aged facts
    aliceStructural: [] as string[], // things Alice CREATED that are not knowledge
  };
  for (let i = 0; i < TOPICS.length; i++) {
    const t = TOPICS[i];
    bait.otherAuthor.push(await record(bob, t, "decision"));
    const rel = await record(bob, t, "fact");
    await link("relates_to", rel, alice);
    bait.related.push(rel);
    const src = await record(bob, t, "fact");
    await link("derived_from", gold[i], src);
    bait.derivedSource.push(src);
    bait.aliceDraft.push(
      await record(alice, t, "decision", { verified: false }),
    );
    bait.aliceStale.push(await record(alice, t, "fact", { at: LONG_AGO }));
  }

  // A collaboration Alice started, and a colleague's person record she filed. Both are authored by
  // her and verified, so nothing about authorship or lifecycle excludes them — only the fact that a
  // structural type names a thing rather than asserting one.
  for (const title of ["PAY-42", "settlement revamp"]) {
    const { entity } = await commit(
      store,
      ontology,
      { type: "collaboration", attributes: { title } },
      prov(alice),
      NOW,
    );
    await verify(store, [entity.id], alice, NOW);
    bait.aliceStructural.push(entity.id);
  }
  {
    const { entity } = await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "Colleague Alice filed" } },
      prov(alice),
      NOW,
    );
    await verify(store, [entity.id], alice, NOW);
    bait.aliceStructural.push(entity.id);
  }

  // ---- Run the persona, whole and per-topic. ----
  const whole = await personaQuery(store, ontology, alice, NOW);
  const wholeIds = new Set(
    [...whole.decisions, ...whole.facts].map((e) => e.id),
  );

  const leaked = (ids: string[]) => ids.filter((id) => wholeIds.has(id));
  const impersonation = [
    ...leaked(bait.otherAuthor),
    ...leaked(bait.related),
    ...leaked(bait.derivedSource),
  ];
  const structuralLeaks = leaked(bait.aliceStructural);
  const draftLeaks = leaked(bait.aliceDraft);
  const staleLeaks = leaked(bait.aliceStale);
  const recalled = gold.filter((id) => wholeIds.has(id));

  // Query recall AND precision in one number: each topic query must return exactly that topic's
  // gold record — one record, the right one. A filter that empties the persona misrepresents by
  // omission; one that stops filtering misrepresents by noise, and counting bare hits would miss it.
  let queryHits = 0;
  for (let i = 0; i < TOPICS.length; i++) {
    const q = await personaQuery(store, ontology, alice, NOW, {
      query: TOPICS[i],
    });
    const ids = new Set([...q.decisions, ...q.facts].map((e) => e.id));
    if (ids.size === 1 && ids.has(gold[i])) queryHits++;
  }

  store.close();

  const returned = wholeIds.size;
  return {
    corpus: {
      goldRecords: gold.length,
      baitRecords:
        bait.otherAuthor.length +
        bait.related.length +
        bait.derivedSource.length +
        bait.aliceDraft.length +
        bait.aliceStale.length +
        bait.aliceStructural.length,
    },
    impersonation: {
      returned,
      foreign: impersonation.length,
      rate: returned === 0 ? 0 : impersonation.length / returned,
    },
    draftLeak: {
      leaked: draftLeaks.length,
      rate: draftLeaks.length / gold.length,
    },
    staleLeak: {
      leaked: staleLeaks.length,
      rate: staleLeaks.length / gold.length,
    },
    structuralLeak: {
      leaked: structuralLeaks.length,
      rate: structuralLeaks.length / bait.aliceStructural.length,
    },
    recall: {
      whole: recalled.length / gold.length,
      query: queryHits / TOPICS.length,
    },
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const r = await run();

console.log("yoke — persona quality eval");
console.log("========================================");
console.log(`gold records (Alice, verified+fresh)  ${r.corpus.goldRecords}`);
console.log(`bait records (5 failure modes)        ${r.corpus.baitRecords}`);
console.log("----------------------------------------");
console.log(
  `persona returned                      ${r.impersonation.returned}`,
);
console.log(`  authored by someone else            ${r.impersonation.foreign}`);
console.log(
  `impersonation rate (target 0%)        ${pct(r.impersonation.rate)}`,
);
console.log(`draft leak rate (target 0%)           ${pct(r.draftLeak.rate)}`);
console.log(`stale leak rate (target 0%)           ${pct(r.staleLeak.rate)}`);
console.log(
  `structural leak rate (target 0%)      ${pct(r.structuralLeak.rate)}`,
);
console.log(`recall, whole persona (target 100%)   ${pct(r.recall.whole)}`);
console.log(`recall, topic queries (target 100%)   ${pct(r.recall.query)}`);
console.log("========================================");
console.log(JSON.stringify(r, null, 2));

process.exit(
  r.impersonation.rate === 0 &&
    r.draftLeak.rate === 0 &&
    r.staleLeak.rate === 0 &&
    r.structuralLeak.rate === 0 &&
    r.recall.whole === 1 &&
    r.recall.query === 1
    ? 0
    : 1,
);
