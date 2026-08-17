#!/usr/bin/env node
// Re-score harness result files, because the harness scores an arm with empty context wrong whatever
// it answered: `runner.py` short-circuits on `not answer_result.context` before the MCQ scorer, so the
// no-memory arm reports 0% while having answered many of them. That zero is the denominator of every
// lift a memory arm would claim, which makes it the one number that must not be quoted as printed.
//
// The comparison lives here rather than in prose because it is the second place that scores these runs
// (the harness is the first) and two scorers that disagree is how a floor ends up quoted two ways. An
// MCQ answer is one letter; both sides are compared on their first character, lowercased.
//
// Usage: node bench/rescore.mjs <results-*.json ...>          # pooled totals + per-file rows
import { readFileSync } from "node:fs";

/** The letter an MCQ answer carries, or "" when the model returned nothing. */
const letter = (s) => (s ?? "").trim().toLowerCase().slice(0, 1);

/** gold_answers ends with the bare letter; earlier elements are the prose form of the same choice. */
const goldLetter = (gold) => letter(gold?.[gold.length - 1]);

export function rescore(run) {
  const rows = run.results ?? [];
  let scored = 0;
  let empty = 0;
  let emptyContext = 0;
  for (const r of rows) {
    const a = letter(r.answer);
    if (!a) {
      empty += 1;
      continue;
    }
    if (!(r.context ?? "").length) emptyContext += 1;
    if (a === goldLetter(r.gold_answers)) scored += 1;
  }
  return {
    provider: run.memory_provider,
    n: rows.length,
    harness: run.correct ?? rows.filter((r) => r.correct).length,
    rescored: scored,
    // An unanswered question is not a wrong one; a floor resting on these is not a floor.
    unanswered: empty,
    emptyContext,
    avgContextTokens: Math.round(run.avg_context_tokens ?? 0),
    answerer: run.answer_llm,
  };
}

const pct = (c, n) => (n ? `${((100 * c) / n).toFixed(1)}%` : "—");

if (process.argv.length > 2) {
  const files = process.argv.slice(2);
  const totals = { n: 0, harness: 0, rescored: 0, unanswered: 0, tok: 0 };
  console.log(
    "file                                      provider   n  harness  rescored  unans  ctx_tok",
  );
  for (const f of files) {
    const r = rescore(JSON.parse(readFileSync(f, "utf8")));
    totals.n += r.n;
    totals.harness += r.harness;
    totals.rescored += r.rescored;
    totals.unanswered += r.unanswered;
    totals.tok += r.avgContextTokens * r.n;
    console.log(
      `${f.split("/").pop().padEnd(41)} ${(r.provider ?? "?").padEnd(9)} ${String(r.n).padStart(2)}  ${String(r.harness).padStart(7)}  ${String(r.rescored).padStart(8)}  ${String(r.unanswered).padStart(5)}  ${String(r.avgContextTokens).padStart(7)}`,
    );
  }
  if (files.length > 1) {
    console.log(
      `\npooled  n=${totals.n}  harness ${totals.harness} (${pct(totals.harness, totals.n)})  ` +
        `re-scored ${totals.rescored} (${pct(totals.rescored, totals.n)})  ` +
        `unanswered ${totals.unanswered}  avg ctx ${Math.round(totals.tok / totals.n)} tokens`,
    );
  }
}
