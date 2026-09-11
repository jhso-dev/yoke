// Injection-quality eval (PLAN 7.2, MARKET strategy 6 "prove it with measurement").
// This is a runnable script, not a vitest suite — the numbers are the deliverable (evidence data for marketing).
// Run: npm run eval  (tsx eval/inject-quality.ts)
//
// Two measurements:
//   1) Contamination rate = the share of retired records among inject() results (expected 0%).
//      Proves the hard rule that injection serves only standing knowledge, by planting a live/retired
//      pair on the same topic side by side and querying it.
//   2) Conflict miss rate = the share of planted opposing-conclusion decision pairs with no conflicts_with
//      created (expected 0%). Gate stage 4 runs only with an embedder + similar(), so we inject a
//      deterministic stub embedder that yields the same vector for the same topic keyword to exercise it.
//
// No number-fudging — if the gate fails, the numbers honestly reveal it.

import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { commit } from "../src/core/commit.js";
import type { Embedder } from "../src/core/embedding.js";
import { inject } from "../src/core/inject.js";
import { deprecate } from "../src/core/lifecycle.js";
import { seedOntology } from "../src/core/ontology.js";
import type { Provenance } from "../src/core/types.js";

const NOW = "2026-07-13T00:00:00Z";
const ACTOR = "eval:seed";
const prov = (): Provenance => ({
  actor: ACTOR,
  origin: "cli",
  occurred_at: NOW,
});

// 20 fact topics. Distinct tokens with no prefix relationship to each other — avoids FTS prefix-match cross-contamination.
const FACT_TOPICS = [
  "photosynthesis",
  "gravity",
  "mitochondria",
  "encryption",
  "inflation",
  "tectonics",
  "serotonin",
  "blockchain",
  "entropy",
  "vaccination",
  "algorithm",
  "democracy",
  "ecosystem",
  "magnetism",
  "evolution",
  "capitalism",
  "neuron",
  "radiation",
  "glaciation",
  "fermentation",
];

// 5 opposing-conclusion decision pairs. Same topic keyword, different conclusions.
const DECISION_PAIRS: Array<{ topic: string; a: string; b: string }> = [
  {
    topic: "caching",
    a: "Use Redis for caching",
    b: "Avoid Redis; keep caching in-process",
  },
  {
    topic: "deployment",
    a: "Adopt blue-green deployment",
    b: "Reject blue-green deployment; roll forward only",
  },
  {
    topic: "authentication",
    a: "Standardize on JWT authentication",
    b: "Drop JWT; use opaque session authentication",
  },
  {
    topic: "pricing",
    a: "Move to seat-based pricing",
    b: "Keep usage-based pricing, no seats",
  },
  {
    topic: "scaling",
    a: "Scale vertically first",
    b: "Scale horizontally, never vertically",
  },
];

const DECISION_TOPICS = DECISION_PAIRS.map((p) => p.topic);

/**
 * Deterministic stub embedder. Emits a one-hot vector over the decision topic keywords present in the text.
 * Same topic → identical vector (cosine 1.0 >= threshold 0.85), different topic → orthogonal (cosine 0).
 * Exercises gate stages 3 & 4 deterministically without a real API (SPEC: tests inject a deterministic stub).
 */
function makeStubEmbedder(topics: string[]): Embedder {
  const dim = Math.max(topics.length, 1);
  return async (text: string) => {
    const v = new Float32Array(dim);
    topics.forEach((t, i) => {
      if (text.includes(t)) v[i] = 1;
    });
    return v;
  };
}

interface Report {
  briefing: {
    /** Of the `leads`-marked records planted on the scope, how many survive in the opening page. */
    planted: number;
    surviving: number;
    noise: number; // noise facts filed after them, competing on recency
  };
  contamination: {
    ftsCandidates: number; // total items FTS raised as candidates (live+retired)
    injected: number; // total items inject() let through
    injectedRetired: number; // of those, retired records (contamination)
    rate: number; // injectedRetired / injected
  };
  conflict: {
    plantedPairs: number;
    detected: number;
    missed: number;
    rate: number; // missed / plantedPairs
  };
}

async function run(): Promise<Report> {
  const store = new SqliteStorage(":memory:");
  await store.init();
  const ontology = seedOntology();

  // (a) 20 live facts + (b) 20 retired facts on the same topics. Committed without an embedder —
  // the contamination measurement only uses inject()'s FTS path, so it is independent of embeddings.
  const retiredIds: string[] = [];
  for (const topic of FACT_TOPICS) {
    const verified = await commit(
      store,
      ontology,
      {
        type: "fact",
        attributes: { topic, statement: `Established finding about ${topic}.` },
      },
      prov(),
      NOW,
    );
    void verified;
    // Assumed-contaminating record: states the same topic differently, then is retired — the one
    // stored status injection must never serve.
    const retired = await commit(
      store,
      ontology,
      {
        type: "fact",
        attributes: {
          topic,
          statement: `Withdrawn claim contradicting ${topic}.`,
        },
      },
      prov(),
      NOW,
    );
    retiredIds.push(retired.entity.id);
  }
  await deprecate(store, retiredIds, ACTOR, NOW);

  // (c) Opposing-conclusion decision pairs — inject the deterministic stub embedder → exercises gate stage 4.
  const embedder = makeStubEmbedder(DECISION_TOPICS);
  const pairIds: Array<[string, string]> = [];
  for (const { topic, a, b } of DECISION_PAIRS) {
    const first = await commit(
      store,
      ontology,
      {
        type: "decision",
        attributes: {
          conclusion: `${a} (${topic})`,
          rationale: `context for ${topic}`,
        },
      },
      prov(),
      NOW,
      { embedder },
    );
    const second = await commit(
      store,
      ontology,
      {
        type: "decision",
        attributes: {
          conclusion: `${b} (${topic})`,
          rationale: `revised context for ${topic}`,
        },
      },
      prov(),
      NOW,
      { embedder },
    );
    pairIds.push([first.entity.id, second.entity.id]);
  }

  // Measurement 1: contamination rate. Per-topic query → share of retired records among inject() results.
  let ftsCandidates = 0;
  let injected = 0;
  let injectedRetired = 0;
  for (const topic of FACT_TOPICS) {
    ftsCandidates += (await store.search({ text: topic })).length;
    const { items } = await inject(store, ontology, topic, NOW, { limit: 100 });
    injected += items.length;
    // Honest judgment: read the injected entity's stored status directly (the source, not effectiveStatus).
    injectedRetired += items.filter(
      (it) => it.entity.status === "deprecated",
    ).length;
  }

  // Measurement 3: gold-in-brief. A working context holds 3 decisions, then a noisy week files 80
  // unrelated facts onto it. The opening briefing (BRIEFING_LIMIT slots) must still carry the
  // decisions — the regression this catches is recency evicting exactly the records a session must
  // not miss (SPEC "A briefing has a defined order", the `leads` rung).
  const ws = await commit(
    store,
    ontology,
    { type: "collaboration", attributes: { title: "gold-in-brief" } },
    prov(),
    NOW,
  );
  const gold: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await commit(
      store,
      ontology,
      {
        type: "decision",
        attributes: {
          conclusion: `standing decision ${i}`,
          rationale: "planted before the noise",
        },
      },
      prov(),
      NOW,
      { attachTo: ws.entity.id },
    );
    gold.push(d.entity.id);
  }
  const NOISE = 80;
  for (let i = 0; i < NOISE; i++)
    await commit(
      store,
      ontology,
      {
        type: "fact",
        attributes: { statement: `unrelated notice ${i} parking snacks` },
      },
      prov(),
      NOW,
      { attachTo: ws.entity.id },
    );
  const brief = await inject(store, ontology, "", NOW, {
    scope: ws.entity.id,
    limit: 50,
  });
  const surviving = gold.filter((id) =>
    brief.items.some((it) => it.entity.id === id),
  ).length;

  // Measurement 2: conflict miss rate. Check in the DB whether each planted pair got a conflicts_with relation.
  const conflictRels = (await store.listRelations({ type: "conflicts_with" }))
    .items;
  const hasEdge = (x: string, y: string): boolean =>
    conflictRels.some(
      (r) => (r.from === x && r.to === y) || (r.from === y && r.to === x),
    );
  let detected = 0;
  for (const [id1, id2] of pairIds) if (hasEdge(id1, id2)) detected++;
  const missed = pairIds.length - detected;

  store.close();

  return {
    briefing: { planted: gold.length, surviving, noise: NOISE },
    contamination: {
      ftsCandidates,
      injected,
      injectedRetired,
      rate: injected === 0 ? 0 : injectedRetired / injected,
    },
    conflict: {
      plantedPairs: pairIds.length,
      detected,
      missed,
      rate: pairIds.length === 0 ? 0 : missed / pairIds.length,
    },
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const r = await run();

// Human-readable table.
console.log("yoke — inject quality eval");
console.log("========================================");
console.log(
  `FTS candidates (live+retired)    ${r.contamination.ftsCandidates}`,
);
console.log(`injected (passed gate)            ${r.contamination.injected}`);
console.log(
  `  of which retired (contamination) ${r.contamination.injectedRetired}`,
);
console.log(`contamination rate (target 0%)    ${pct(r.contamination.rate)}`);
console.log(
  `gold-in-brief (target all)        ${r.briefing.surviving}/${r.briefing.planted} decisions survive ${r.briefing.noise} noise facts`,
);
console.log("----------------------------------------");
console.log(`decision pairs (planted)          ${r.conflict.plantedPairs}`);
console.log(`conflicts_with created (detected) ${r.conflict.detected}`);
console.log(`conflict miss rate (target 0%)    ${pct(r.conflict.rate)}`);
console.log("========================================");

// Machine-readable JSON.
console.log(JSON.stringify(r, null, 2));

// Non-zero exit on anomalies (contamination > 0 or misses > 0) — so CI/humans notice immediately.
process.exit(
  r.contamination.rate === 0 &&
    r.conflict.rate === 0 &&
    r.briefing.surviving === r.briefing.planted
    ? 0
    : 1,
);
