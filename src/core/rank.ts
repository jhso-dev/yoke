// Relevance ordering for adapters with no ranker of their own.
//
// SPEC's search clause 6 says results come back best-match first, and clause 8 says how multi-term
// queries combine. Every backend shipping today answers both with a native index — FTS5's bm25,
// OpenSearch's BM25, Postgres' ts_rank — so what they need from here is the tokenizer and the
// clause-8 decision, and nothing else. An adapter that ranks in JS instead needs a ranker; the one
// that does is the conformance fake, and it carries its own (ports/conformance.self.test.ts).
//
// What ranking prevents, wherever it happens: an adapter that matches in JS and then `slice()`s
// whatever order its scan produced makes `limit` mean "an arbitrary N". Measured on sqlite, the
// arbitrary N and the relevant N shared one record in fifty (docs/SCALE.md).

/** Lowercase, then split on any run of non-letter/non-number characters (unicode-aware).
 *
 * Hangul are letters, so "parseArgs로" stays ONE token and a query for "parseArgs" reaches it by
 * prefix — that is conformance case 6b, and why this is prefix matching rather than equality.
 * JSON quotes, braces and colons separate, so serialized attributes tokenize into their words.
 *
 * One copy, because every adapter that tokenizes has to tokenize the same way: divergent tokenizers are
 * divergent search semantics. */
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
 * Safe only because ranking (clause 6) exists: without it the AND is the port's only precision.
 */
export const AND_TERM_LIMIT = 3;

/** The clause-8 decision itself, so every adapter that builds a native query expression and anything
 * matching in JS (today: the conformance fake) read it from one place. */
export function requireEveryTerm(
  tokenCount: number,
  terms: "auto" | "all" = "auto",
): boolean {
  return terms === "all" || tokenCount <= AND_TERM_LIMIT;
}
