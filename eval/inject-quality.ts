// 주입 품질 eval (PLAN 7.2, MARKET 전략 6 "측정으로 증명").
// vitest가 아니라 실행 스크립트다 — 수치가 산출물(마케팅 근거 데이터).
// 실행: npm run eval  (tsx eval/inject-quality.ts)
//
// 측정 두 가지:
//   1) 오염 주입률 = inject() 결과 중 draft 비율 (기대 0%).
//      게이트가 verified만 주입한다는 하드 규칙을, 같은 주제의 verified/draft를
//      나란히 심고 질의해 증명한다.
//   2) 모순 미탐지율 = 심어둔 반대 결론 decision 쌍 중 conflicts_with 미생성 비율
//      (기대 0%). 게이트 4단계는 embedder + similar()가 있어야 동작하므로,
//      주제 키워드가 같으면 동일 벡터를 내는 결정적 스텁 embedder를 주입해 실동작시킨다.
//
// 수치 조작 금지 — 게이트가 실패하면 수치가 정직하게 그것을 드러낸다.

import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { commit } from "../src/core/commit.js";
import type { Embedder } from "../src/core/embedding.js";
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

// 사실용 주제 20종. 서로 접두 관계 없는 distinct 토큰 — FTS 접두 매칭 교차오염 회피.
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

// 반대 결론 decision 쌍 5쌍. 주제 키워드가 같고 conclusion이 다르다.
const DECISION_PAIRS: Array<{ topic: string; a: string; b: string }> = [
  { topic: "caching", a: "Use Redis for caching", b: "Avoid Redis; keep caching in-process" },
  { topic: "deployment", a: "Adopt blue-green deployment", b: "Reject blue-green deployment; roll forward only" },
  { topic: "authentication", a: "Standardize on JWT authentication", b: "Drop JWT; use opaque session authentication" },
  { topic: "pricing", a: "Move to seat-based pricing", b: "Keep usage-based pricing, no seats" },
  { topic: "scaling", a: "Scale vertically first", b: "Scale horizontally, never vertically" },
];

const DECISION_TOPICS = DECISION_PAIRS.map((p) => p.topic);

/**
 * 결정적 스텁 embedder. 텍스트에 등장하는 decision 주제 키워드의 one-hot 벡터를 낸다.
 * 같은 주제 → 동일 벡터(코사인 1.0 ≥ 임계 0.85), 다른 주제 → 직교(코사인 0).
 * 실 API 없이 게이트 3·4단계를 결정적으로 실동작시킨다 (SPEC: 테스트는 결정적 스텁 주입).
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
  contamination: {
    ftsCandidates: number; // FTS가 후보로 올린 총 항목 (verified+draft)
    injected: number; // inject()가 통과시킨 총 항목
    injectedDraft: number; // 그중 draft (오염)
    rate: number; // injectedDraft / injected
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

  // (a) verified 사실 20 + (b) 같은 주제 draft 사실 20. embedder 없이 커밋 —
  // 오염 측정은 inject()의 FTS 경로만 쓰므로 임베딩과 무관하다.
  const verifiedIds: string[] = [];
  for (const topic of FACT_TOPICS) {
    const verified = await commit(
      store,
      ontology,
      { type: "fact", attributes: { topic, statement: `Established finding about ${topic}.` } },
      prov(),
      NOW,
    );
    verifiedIds.push(verified.entity.id);
    // 오염 가정 draft: 같은 주제를 다르게 서술. verify하지 않는다 → draft로 남는다.
    await commit(
      store,
      ontology,
      { type: "fact", attributes: { topic, statement: `Unverified rumor contradicting ${topic}.` } },
      prov(),
      NOW,
    );
  }
  await verify(store, verifiedIds, ACTOR, NOW);

  // (c) 반대 결론 decision 쌍 — 결정적 스텁 embedder 주입 → 게이트 4단계 실동작.
  const embedder = makeStubEmbedder(DECISION_TOPICS);
  const pairIds: Array<[string, string]> = [];
  for (const { topic, a, b } of DECISION_PAIRS) {
    const first = await commit(
      store,
      ontology,
      { type: "decision", attributes: { conclusion: `${a} (${topic})`, rationale: `context for ${topic}` } },
      prov(),
      NOW,
      { embedder },
    );
    const second = await commit(
      store,
      ontology,
      { type: "decision", attributes: { conclusion: `${b} (${topic})`, rationale: `revised context for ${topic}` } },
      prov(),
      NOW,
      { embedder },
    );
    pairIds.push([first.entity.id, second.entity.id]);
  }

  // 측정 1: 오염 주입률. 주제별 질의 → inject() 결과의 draft 비율.
  let ftsCandidates = 0;
  let injected = 0;
  let injectedDraft = 0;
  for (const topic of FACT_TOPICS) {
    ftsCandidates += (await store.search({ text: topic })).length;
    const { items } = await inject(store, ontology, topic, NOW, { limit: 100 });
    injected += items.length;
    // 정직한 판정: 주입된 entity의 저장 status를 직접 본다 (effectiveStatus가 아니라 원천).
    injectedDraft += items.filter((it) => it.entity.status === "draft").length;
  }

  // 측정 2: 모순 미탐지율. 심어둔 각 쌍에 conflicts_with 관계가 생겼는지 DB에서 확인.
  const conflictRels = store.listRelationsByType("conflicts_with");
  const hasEdge = (x: string, y: string): boolean =>
    conflictRels.some(
      (r) => (r.from === x && r.to === y) || (r.from === y && r.to === x),
    );
  let detected = 0;
  for (const [id1, id2] of pairIds) if (hasEdge(id1, id2)) detected++;
  const missed = pairIds.length - detected;

  store.close();

  return {
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
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

const r = await run();

// 사람 읽는 표.
console.log("yoke — inject quality eval");
console.log("========================================");
console.log(`FTS candidates (verified+draft)  ${r.contamination.ftsCandidates}`);
console.log(`injected (passed gate)           ${r.contamination.injected}`);
console.log(`  of which draft (contamination) ${r.contamination.injectedDraft}`);
console.log(`오염 주입률 (target 0%)          ${pct(r.contamination.rate)}`);
console.log("----------------------------------------");
console.log(`decision 쌍 (planted)            ${r.conflict.plantedPairs}`);
console.log(`conflicts_with 생성 (detected)   ${r.conflict.detected}`);
console.log(`모순 미탐지율 (target 0%)        ${pct(r.conflict.rate)}`);
console.log("========================================");

// 기계용 JSON.
console.log(JSON.stringify(r, null, 2));

// 비정상(오염>0 또는 미탐지>0)이면 non-zero exit — CI/사람이 즉시 인지.
process.exit(r.contamination.rate === 0 && r.conflict.rate === 0 ? 0 : 1);
