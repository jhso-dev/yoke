// Injection-quality eval (PLAN 7.2, MARKET strategy 6 "prove it with measurement").
// This is a runnable script, not a vitest suite — the numbers are the deliverable (evidence data for marketing).
// Run: npm run eval  (tsx eval/inject-quality.ts)
//
// Three measurements, and the third exists to stop the first two from being quoted as more than they are:
//   1) Contamination rate = the share of drafts among inject() results (expected 0%).
//      Proves the hard rule that the gate injects only verified knowledge, by planting a verified/draft
//      pair on the same topic side by side and querying it.
//   2) Conflict miss rate = the share of planted opposing-conclusion decision pairs with no conflicts_with
//      created (expected 0%) — recall of the contradiction detector.
//   3) False-conflict rate = the share of planted COMPATIBLE same-topic pairs that got a conflicts_with
//      anyway — precision of the same detector. A recall figure alone says nothing about whether the
//      edges mean anything, and this detector's only input is the conclusion text (commit.ts stage 4),
//      so a refinement and a reversal are indistinguishable to it by construction. Expect this number
//      to be bad; it is the honest cost of surfacing every disagreement rather than missing them.
//
// Gate stages 3 & 4 need an embedder. With YOKE_EMBED_URL / YOKE_EMBED_MODEL set the real one runs and
// the numbers describe real vectors; without them a deterministic stub keyed on the topic word runs so
// the wiring is still exercised, and every line of output says which — a stub number measures that
// stage 4 files an edge, never that an embedding model would have noticed.
//
// No number-fudging — if the gate fails, the numbers honestly reveal it.

import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { commit } from "../src/core/commit.js";
import { type Embedder, makeFetchEmbedder } from "../src/core/embedding.js";
import { inject } from "../src/core/inject.js";
import { verify } from "../src/core/lifecycle.js";
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

// 5 COMPATIBLE same-topic decision pairs — the precision probe. Each second conclusion narrows,
// schedules or qualifies the first; none reverses it. A `conflicts_with` on any of these is a false
// positive, and a human sent to settle a disagreement that does not exist.
const COMPATIBLE_PAIRS: Array<{ topic: string; a: string; b: string }> = [
  {
    topic: "logging",
    a: "Ship structured logs as JSON",
    b: "Ship structured logs as JSON, one event per line",
  },
  {
    topic: "backups",
    a: "Take nightly database backups",
    b: "Take nightly database backups, retained for 30 days",
  },
  {
    topic: "onboarding",
    a: "Pair new engineers with a mentor",
    b: "Pair new engineers with a mentor for their first two weeks",
  },
  {
    topic: "linting",
    a: "Run the linter in CI",
    b: "Run the linter in CI, blocking merge on error",
  },
  {
    topic: "rollout",
    a: "Roll features out behind a flag",
    b: "Roll features out behind a flag, starting at 5% of traffic",
  },
];

const DECISION_TOPICS = [...DECISION_PAIRS, ...COMPATIBLE_PAIRS].map(
  (p) => p.topic,
);

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

/** Which embedder this run used. Printed on every line of output that depends on it. */
const EMBEDDER =
  process.env.YOKE_EMBED_URL && process.env.YOKE_EMBED_MODEL
    ? {
        kind: "real" as const,
        label: `${process.env.YOKE_EMBED_MODEL} @ ${process.env.YOKE_EMBED_URL}`,
      }
    : {
        kind: "stub" as const,
        label: "deterministic stub (one-hot on the topic word)",
      };

interface Report {
  embedder: { kind: "real" | "stub"; label: string };
  contamination: {
    ftsCandidates: number; // total items FTS raised as candidates (verified+draft)
    injected: number; // total items inject() let through
    injectedDraft: number; // of those, drafts (contamination)
    rate: number; // injectedDraft / injected
  };
  conflict: {
    plantedPairs: number;
    detected: number;
    missed: number;
    rate: number; // missed / plantedPairs — recall's complement
  };
  falseConflict: {
    plantedPairs: number; // compatible pairs, which must NOT be linked
    flagged: number; // of those, linked anyway
    rate: number; // flagged / plantedPairs
  };
}

async function run(): Promise<Report> {
  const store = new SqliteStorage(":memory:");
  await store.init();
  const ontology = seedOntology();

  // (a) 20 verified facts + (b) 20 draft facts on the same topics. Committed without an embedder —
  // the contamination measurement only uses inject()'s FTS path, so it is independent of embeddings.
  const verifiedIds: string[] = [];
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
    verifiedIds.push(verified.entity.id);
    // Assumed-contaminating draft: states the same topic differently. Left unverified → stays a draft.
    await commit(
      store,
      ontology,
      {
        type: "fact",
        attributes: {
          topic,
          statement: `Unverified rumor contradicting ${topic}.`,
        },
      },
      prov(),
      NOW,
    );
  }
  await verify(store, verifiedIds, ACTOR, NOW);

  // (c) Decision pairs — opposing (recall) and compatible (precision) — through gate stage 4.
  const embedder =
    EMBEDDER.kind === "real"
      ? makeFetchEmbedder(process.env)
      : makeStubEmbedder(DECISION_TOPICS);
  const plant = async (
    pairs: typeof DECISION_PAIRS,
  ): Promise<Array<[string, string]>> => {
    const ids: Array<[string, string]> = [];
    for (const { topic, a, b } of pairs) {
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
      ids.push([first.entity.id, second.entity.id]);
    }
    return ids;
  };
  const pairIds = await plant(DECISION_PAIRS);
  const compatibleIds = await plant(COMPATIBLE_PAIRS);

  // Measurement 1: contamination rate. Per-topic query → share of drafts among inject() results.
  let ftsCandidates = 0;
  let injected = 0;
  let injectedDraft = 0;
  for (const topic of FACT_TOPICS) {
    ftsCandidates += (await store.search({ text: topic })).length;
    const { items } = await inject(store, ontology, topic, NOW, { limit: 100 });
    injected += items.length;
    // Honest judgment: read the injected entity's stored status directly (the source, not effectiveStatus).
    injectedDraft += items.filter((it) => it.entity.status === "draft").length;
  }

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

  // Measurement 3: false-conflict rate. The compatible pairs must have no edge between them.
  let flagged = 0;
  for (const [id1, id2] of compatibleIds) if (hasEdge(id1, id2)) flagged++;

  store.close();

  return {
    embedder: EMBEDDER,
    contamination: {
      ftsCandidates,
      injected,
      injectedDraft,
      rate: injected === 0 ? 0 : injectedDraft / injected,
    },
    conflict: {
      plantedPairs: pairIds.length,
      detected,
      missed,
      rate: pairIds.length === 0 ? 0 : missed / pairIds.length,
    },
    falseConflict: {
      plantedPairs: compatibleIds.length,
      flagged,
      rate: compatibleIds.length === 0 ? 0 : flagged / compatibleIds.length,
    },
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const r = await run();

// Human-readable table.
console.log("yoke — inject quality eval");
console.log(`embedder: ${r.embedder.label}`);
console.log("========================================");
console.log(
  `FTS candidates (verified+draft)   ${r.contamination.ftsCandidates}`,
);
console.log(`injected (passed gate)            ${r.contamination.injected}`);
console.log(
  `  of which draft (contamination)  ${r.contamination.injectedDraft}`,
);
console.log(`contamination rate (target 0%)    ${pct(r.contamination.rate)}`);
console.log("----------------------------------------");
console.log(`opposing pairs (planted)          ${r.conflict.plantedPairs}`);
console.log(`conflicts_with created (detected) ${r.conflict.detected}`);
console.log(`conflict miss rate (target 0%)    ${pct(r.conflict.rate)}`);
console.log("----------------------------------------");
console.log(
  `compatible pairs (planted)        ${r.falseConflict.plantedPairs}`,
);
console.log(`  linked anyway (false positive)  ${r.falseConflict.flagged}`);
console.log(`false-conflict rate (measured)    ${pct(r.falseConflict.rate)}`);
console.log("========================================");
if (r.embedder.kind === "stub") {
  console.log(
    "Stub embedder: the conflict numbers measure that stage 4 files an edge, not that an\n" +
      "embedding model would notice. Set YOKE_EMBED_URL and YOKE_EMBED_MODEL for the real figure.",
  );
}

// Machine-readable JSON.
console.log(JSON.stringify(r, null, 2));

// Non-zero exit on the two invariants only — contamination and missed contradictions are rules the gate
// must keep. The false-conflict rate is a measured property of a heuristic whose ceiling is known and
// documented (commit.ts stage 4 judges on conclusion text alone), so gating on it would turn a stated
// limit into a red build without changing what anyone can do about it.
process.exit(r.contamination.rate === 0 && r.conflict.rate === 0 ? 0 : 1);
