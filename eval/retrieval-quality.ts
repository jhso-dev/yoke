// Retrieval-quality eval (v5.5) — recall@k, nDCG@k and accuracy@1 over a hand-written gold set.
//
//   node scripts/load-demo-corpus.mjs ./demo-yoke.db     # once
//   npx tsx eval/retrieval-quality.ts ./demo-yoke.db     # any backend openStore understands
//
// Why this exists: `eval/inject-quality.ts` measures SAFETY only — contamination and missed
// contradictions — so until now nothing in the repo could say whether a retrieval change helped. v5.3
// shipped hybrid retrieval on the strength of eight hand-run queries, and named its own ceiling: when
// one half returns nothing, RRF degenerates to the other half's order. Eight queries cannot say how
// often that happens. This can.
//
// It measures `inject()`, not `search()`: what an agent actually receives, gate and all. Consequence
// worth stating — a gold target that is draft, stale or deprecated is UNREACHABLE by design, so the
// run reports those instead of scoring them, and the gold set is expected to name injectable records.
//
// The keyword/hybrid comparison is the whole point, so the same queries run twice: once with the
// env-configured embedder and once with none. Without `YOKE_EMBED_URL` only the keyword column is
// produced, and the report says so rather than printing a hybrid column that is a copy.
//
// No pass/fail threshold. There is no baseline yet, and a threshold invented on the first run is a
// number chosen to be met. The exception is the gold set drifting out of sync with the corpus, which
// IS a failure — an unresolvable target silently scores zero and reads as a retrieval regression.

import { readFileSync } from "node:fs";
import { makeFetchEmbedder } from "../src/core/embedding.js";
import { inject } from "../src/core/inject.js";
import { seedOntology } from "../src/core/ontology.js";
import { openStore } from "../src/front/store.js";

/** How deep the metrics look. 10 is the front tier's default briefing size rounded up — the window a
 * person or an agent actually reads before deciding the answer is not here. */
const K = 10;

interface GoldQuery {
  q: string;
  /** `question` = a sentence, how an agent's user asks. `keywords` = one to three terms, how a person
   * searches a wiki. Scored separately: a set of one shape only makes one retriever look broken when
   * what actually differs is the query. */
  shape: "question" | "keywords";
  relevant: string[];
}

const db = process.argv[2];
if (!db) {
  console.error(
    "usage: tsx eval/retrieval-quality.ts <db>   (load it first: node scripts/load-demo-corpus.mjs <db>)",
  );
  process.exit(2);
}

const gold = JSON.parse(readFileSync("eval/gold-set.json", "utf8")) as {
  corpus: string;
  queries: GoldQuery[];
};

// --- resolve `<file>#<key>` to stored ids -------------------------------------------------------
//
// `key` is an authoring handle and is not stored (see the corpus README), so the bridge is the record's
// own text: `title` or `conclusion`, which the gate stores verbatim. Exact-match, and a collision or a
// miss is reported rather than guessed at.
const signatureOf = (attrs: Record<string, unknown>): string =>
  String(attrs.title ?? attrs.conclusion ?? "");

const named = new Set(gold.queries.flatMap((g) => g.relevant));
const wantByKey = new Map<string, string>(); // file#key -> signature
for (const file of new Set([...named].map((r) => r.split("#")[0]))) {
  const doc = JSON.parse(readFileSync(`${gold.corpus}/${file}`, "utf8")) as {
    records?: Array<{ key: string; attributes: Record<string, unknown> }>;
  };
  // Only the keys the gold set actually names. Indexing every record in the file made the
  // "cannot inject" report list 47 drafts nobody had asked about, which is noise that hides the
  // handful that are a real problem with the set.
  for (const r of doc.records ?? [])
    if (named.has(`${file}#${r.key}`))
      wantByKey.set(`${file}#${r.key}`, signatureOf(r.attributes));
}

const store = await openStore({ db }, process.env);
await store.init();
const ontology = seedOntology();

// One enumeration pass builds signature -> id. Cheaper than a search per gold target, and it is the
// only way to see a duplicate signature at all.
const idBySignature = new Map<string, string[]>();
const statusById = new Map<string, string>();
let after: string | undefined;
for (;;) {
  const page = await store.listEntities({ after, limit: 500 });
  for (const e of page.items) {
    const sig = signatureOf(e.attributes);
    if (!sig) continue;
    (idBySignature.get(sig) ?? idBySignature.set(sig, []).get(sig))?.push(e.id);
    statusById.set(e.id, e.status);
  }
  if (page.next === null) break;
  after = page.next;
}

const unresolved: string[] = [];
const ambiguous: string[] = [];
const notInjectable: string[] = [];
const idByKey = new Map<string, string>();
for (const [key, sig] of wantByKey) {
  const ids = idBySignature.get(sig);
  if (!ids || ids.length === 0) {
    unresolved.push(key);
    continue;
  }
  if (ids.length > 1)
    ambiguous.push(`${key} (${ids.length} records share its title)`);
  idByKey.set(key, ids[0]);
  // 'stale' is computed at read time and never stored, so this catches draft/deprecated only; a stale
  // target still fails to inject and shows up as a miss. Reported either way, never silently zeroed.
  if (statusById.get(ids[0]) !== "verified")
    notInjectable.push(`${key} (${statusById.get(ids[0])})`);
}

// --- metrics -------------------------------------------------------------------------------------

/** Binary-relevance nDCG@k. Ideal DCG puts every relevant record at the top, so a query with more
 * relevant records than `k` is not penalised for the ones that could not fit. */
function ndcg(hitAt: boolean[], relevantCount: number, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(hitAt.length, k); i++)
    if (hitAt[i]) dcg += 1 / Math.log2(i + 2);
  let ideal = 0;
  for (let i = 0; i < Math.min(relevantCount, k); i++)
    ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

interface Score {
  recall: number;
  ndcg: number;
  hit1: number;
  found: number;
  want: number;
}

async function scoreAll(
  embedder: Parameters<typeof inject>[4] extends undefined
    ? never
    : NonNullable<Parameters<typeof inject>[4]>["embedder"],
  shape?: GoldQuery["shape"],
): Promise<{ per: Array<Score & { q: string }>; mean: Score }> {
  const per: Array<Score & { q: string }> = [];
  for (const g of gold.queries.filter((x) => !shape || x.shape === shape)) {
    const want = new Set(
      g.relevant.map((r) => idByKey.get(r)).filter((x): x is string => !!x),
    );
    const { items } = await inject(store, ontology, g.q, NOW, {
      limit: K,
      embedder,
    });
    const hitAt = items.map((it) => want.has(it.entity.id));
    const found = hitAt.filter(Boolean).length;
    per.push({
      q: g.q,
      recall: want.size === 0 ? 0 : found / want.size,
      ndcg: ndcg(hitAt, want.size, K),
      hit1: hitAt[0] ? 1 : 0,
      found,
      want: want.size,
    });
  }
  const mean = (pick: (s: Score) => number) =>
    per.reduce((a, s) => a + pick(s), 0) / per.length;
  return {
    per,
    mean: {
      recall: mean((s) => s.recall),
      ndcg: mean((s) => s.ndcg),
      hit1: mean((s) => s.hit1),
      found: per.reduce((a, s) => a + s.found, 0),
      want: per.reduce((a, s) => a + s.want, 0),
    },
  };
}

/** The clock. Fixed rather than `new Date()`: freshness decides what injects, so a wall-clock run
 * would score differently every day and the numbers would not be comparable (SPEC "Time injection"). */
const NOW = "2026-08-04T12:00:00Z";

const embedder = makeFetchEmbedder(process.env);
const hasVectors = (await embedder("probe")) !== null;

const shapes = ["question", "keywords"] as const;
const keyword = await scoreAll(undefined);
const hybrid = hasVectors ? await scoreAll(embedder) : null;
const byShape = new Map<string, { keyword: Score; hybrid: Score | null }>();
for (const s of shapes)
  byShape.set(s, {
    keyword: (await scoreAll(undefined, s)).mean,
    hybrid: hasVectors ? (await scoreAll(embedder, s)).mean : null,
  });
store.close();

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const row = (label: string, k: number, h: number | null) =>
  `${label.padEnd(22)}${pct(k).padStart(8)}${h === null ? "        —" : pct(h).padStart(9)}`;

console.log(
  `yoke — retrieval quality  (${gold.queries.length} queries, k=${K})`,
);
console.log("=".repeat(50));
console.log(`${"".padEnd(22)}${"keyword".padStart(8)}${"hybrid".padStart(9)}`);
console.log(row("recall@10", keyword.mean.recall, hybrid?.mean.recall ?? null));
console.log(row("nDCG@10", keyword.mean.ndcg, hybrid?.mean.ndcg ?? null));
console.log(row("accuracy@1", keyword.mean.hit1, hybrid?.mean.hit1 ?? null));
console.log("=".repeat(50));
console.log(
  `relevant records found: ${keyword.mean.found}/${keyword.mean.want} keyword` +
    (hybrid ? `, ${hybrid.mean.found}/${hybrid.mean.want} hybrid` : ""),
);

// By query shape. This breakdown is what stops "keyword 0%" being read as "BM25 is broken": the two
// cohorts ask the same corpus for the same things in two different shapes.
console.log("\nby query shape");
console.log("-".repeat(50));
for (const s of shapes) {
  const m = byShape.get(s);
  if (!m) continue;
  const n = gold.queries.filter((q) => q.shape === s).length;
  console.log(`${s} (${n})`);
  console.log(row("  recall@10", m.keyword.recall, m.hybrid?.recall ?? null));
  console.log(row("  accuracy@1", m.keyword.hit1, m.hybrid?.hit1 ?? null));
}
if (!hasVectors)
  console.log(
    "\nno embedder — hybrid column omitted. Set YOKE_EMBED_URL/YOKE_EMBED_MODEL to measure it.",
  );

// Queries that returned nothing relevant are the interesting ones, so name them rather than averaging
// them away. Ranked by what the better of the two columns managed.
const best = hybrid ?? keyword;
const worst = best.per
  .filter((s) => s.recall === 0)
  .map((s) => `  0/${s.want}  ${s.q}`);
if (worst.length) {
  console.log(`\nfound nothing relevant (${worst.length}):`);
  console.log(worst.join("\n"));
}

for (const [label, list] of [
  ["gold targets not present in this database", unresolved],
  ["gold targets whose title is not unique", ambiguous],
  ["gold targets that cannot inject (not verified)", notInjectable],
] as const) {
  if (list.length)
    console.log(`\n${label} (${list.length}):\n  ${list.join("\n  ")}`);
}

console.log(
  `\n${JSON.stringify(
    {
      k: K,
      queries: gold.queries.length,
      keyword: keyword.mean,
      hybrid: hybrid?.mean ?? null,
      byShape: Object.fromEntries(byShape),
      unresolved: unresolved.length,
      ambiguous: ambiguous.length,
      notInjectable: notInjectable.length,
    },
    null,
    2,
  )}`,
);

// A gold set that has drifted out of sync with the corpus is a failure — an unresolvable target scores
// zero and is indistinguishable from a retrieval regression. Low scores are not a failure; they are
// the measurement.
process.exit(unresolved.length === 0 ? 0 : 1);
