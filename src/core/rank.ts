// Relevance ordering for adapters with no ranker of their own.
//
// SPEC's search clause 6 says results come back best-match first. sqlite has FTS5's bm25 and uses
// it; kuzu and qdrant match tokens in JS and used to `slice()` whatever order the scan produced,
// which meant `limit` silently meant "an arbitrary N". Measured on sqlite, the arbitrary N and the
// relevant N shared one record in fifty (docs/SCALE.md) — that is the defect this closes for the
// other two.
//
// Textbook BM25 rather than something invented here: it is what FTS5 computes, so all three
// adapters can satisfy one conformance case, and the parameters below are the standard ones. The
// cost is nothing extra — both callers have already materialized and tokenized every row, which is
// their documented full-scan ceiling.

/** Lowercase, then split on any run of non-letter/non-number characters (unicode-aware).
 *
 * Hangul are letters, so "parseArgs로" stays ONE token and a query for "parseArgs" reaches it by
 * prefix — that is conformance case 6b, and why this is prefix matching rather than equality.
 * JSON quotes, braces and colons separate, so serialized attributes tokenize into their words.
 *
 * Lived in both the kuzu and qdrant adapters, identically. One copy, since the ranker needs it too
 * and three divergent tokenizers would be three different search semantics. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Up to this many query tokens, every one must match; beyond it, any one does (SPEC search clause 8).
 *
 * Two or three terms is someone searching a wiki and meaning all of them. A fourth token means a
 * sentence, and a sentence is an unsatisfiable conjunction: measured over `eval/gold-set.json`, the
 * AND found 0 of 91 relevant records across 55 question-shaped queries while scoring 90.9% recall on
 * the keyword-shaped ones.
 *
 * Safe only because ranking (clause 6) landed first — the AND used to be the port's only precision.
 */
export const AND_TERM_LIMIT = 3;

/**
 * Does `docText` satisfy `qTokens` under clause 8? A query token matches any document token it
 * PREFIXES, which is case 6b (Hangul stay attached to their stem, so `parseArgs` must reach
 * `parseArgs로`).
 *
 * The three adapters with no full-text index of their own (kuzu, qdrant, and sqlite's fallback
 * reasoning) had this predicate inlined identically. One copy, because two copies of a matching rule
 * is two search semantics — which is exactly how the AND survived unnoticed in five places.
 */
export function matchesTokens(qTokens: string[], docText: string): boolean {
  if (qTokens.length === 0) return false;
  const docTokens = tokenize(docText);
  const hit = (qt: string) => docTokens.some((dt) => dt.startsWith(qt));
  return qTokens.length <= AND_TERM_LIMIT
    ? qTokens.every(hit)
    : qTokens.some(hit);
}

/** BM25's usual constants: k1 bounds how much repetition helps, b how much length is penalised. */
const K1 = 1.2;
const B = 0.75;

/**
 * Sort `rows` best-match first for `query`, by BM25 over the text `textOf` returns.
 *
 * Stable within a score, and the tiebreak is the row's own order — so two equally relevant records
 * keep whatever order the caller had, which for these adapters is id order and therefore
 * deterministic across backends.
 *
 * A query token scores against any document token it PREFIXES, matching how these adapters decide
 * what matched in the first place; a ranker that scored only exact tokens would rank a Korean hit
 * at zero and sort the one relevant record last.
 */
export function rankByRelevance<T>(
  rows: T[],
  query: string,
  textOf: (row: T) => string,
): T[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || rows.length === 0) return rows;

  const docs = rows.map((row) => tokenize(textOf(row)));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;

  // Document frequency per query token, over this candidate set. It is the set the caller is
  // ranking, so "how rare is this token here" is the only idf available and the right one.
  const df = qTokens.map(
    (qt) => docs.filter((d) => d.some((t) => t.startsWith(qt))).length,
  );

  const scored = rows.map((row, i) => {
    const d = docs[i];
    let score = 0;
    for (let k = 0; k < qTokens.length; k++) {
      const tf = d.filter((t) => t.startsWith(qTokens[k])).length;
      if (tf === 0) continue;
      // Standard idf with the +0.5 smoothing, so a token present in every candidate contributes
      // almost nothing rather than a negative weight.
      const idf = Math.log(1 + (rows.length - df[k] + 0.5) / (df[k] + 0.5));
      score +=
        (idf * (tf * (K1 + 1))) /
        (tf + K1 * (1 - B + (B * d.length) / (avgLen || 1)));
    }
    return { row, score, i };
  });

  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.row);
}
