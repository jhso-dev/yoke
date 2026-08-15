#!/usr/bin/env node
// Give an UNDATED benchmark corpus a timeline, by reading order off the source documents.
//
// EVAL TOOL, NOT A PRODUCT FEATURE. It lives in bench/ next to the harness provider for that reason:
// nothing in src/ knows it exists, `yoke repair` does not offer it, and it must never be pointed at a
// store anyone keeps. The dates it writes are SYNTHETIC and they encode ORDER, not truth — no
// PersonaMem session says when it happened, so a record dated 2025-01-03T04:00:00Z means "third
// document, a fifth of the way in", nothing more. Anything that reads these as real event times is
// reading a fabrication.
//
// Why it is needed: the harness feeds each session to `yoke connect raw` as a file written moments
// before, so `sourceTime` falls back to one mtime per file and every record of a run shares one
// `occurred_at` (bench/README.md, and `source_order` in bench/yoke_provider.py which exists to work
// around exactly this). Time-aware injection — `--as-of`, recency ranking, the dated-timeline arm —
// has no signal to work with. The order IS recoverable: every record carries `attributes.sources`,
// a verbatim quote of the conversation it came from, and `external_id` names the file
// (`raw:<NNNNN>-<doc id>.md#<n>`), whose NNNNN is the session's position in the persona's history.
// So: document index → the day, character offset of the quote within that document → the hour.
//
// The write goes through core's `restampOccurredAt` — the same mechanism `yoke repair --occurred-at`
// uses. It APPENDS a version preserving status/actor/origin/last_confirmed and parks the displaced
// ingest instant in `transitioned_at`; nothing is overwritten and nothing is deleted. Re-running is a
// no-op, since the date is a function of the record.
//
// Usage:
//   node bench/backfill-ordinal-dates.mjs <store.db> --corpus <shared_contexts_32k.jsonl> \
//        --ns <persona/context id> [--dry-run] [--base 2025-01-01]
//
//   The corpus jsonl is the one the harness downloaded: <amb>/.datasets/personamem/shared_contexts_32k.jsonl
//   The ns is the PersonaMem `shared_context_id` the run used as its user_id. If you do not have it:
//        sqlite3 <store.db> "select distinct ns from entities"
//
// WORK ON A COPY. `cp store.db copy.db` first — this rewrites the audit trail of whatever it opens.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
/** Hours of the synthetic day one document is spread across. Under 24 so the last record of a
 * document still sorts before the first record of the next one — that gap is the whole encoding. */
const DOC_SPAN_HOURS = 20;
/** Shortest prefix of a quote worth trusting as a location. Below this a "match" is a coincidence. */
const MIN_PARTIAL_CHARS = 40;

// ── the encoding ──────────────────────────────────────────────────────────────

/** (document index, character offset) → an ISO instant that sorts the same way. */
export function ordinalDate(docIndex, offset, docLen, baseMs) {
  const frac = docLen > 0 ? Math.min(Math.max(offset, 0), docLen) / docLen : 0;
  return new Date(
    baseMs + docIndex * DAY_MS + Math.round(frac * DOC_SPAN_HOURS * 3_600_000),
  ).toISOString();
}

// ── the corpus, reconstructed exactly as the harness fed it ───────────────────
// src/memory_bench/dataset/personamem.py: a context is a flat turn list, a `system` turn opens a new
// session, a document is one session rendered as "[ROLE] content" blocks. Reproduced rather than
// imported because the harness is Python and this has to agree with it character for character —
// the offsets are computed against this string.

export function splitSessions(turns) {
  const out = [];
  let cur = [];
  for (const t of turns) {
    if (t.role === "system" && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function formatSession(turns) {
  return turns
    .filter((t) => (t.content || "").trim())
    .map((t) => `[${(t.role || "").trim().toUpperCase()}] ${t.content.trim()}`)
    .join("\n\n");
}

/** jsonl → Map<context id, document text[]>, documents in the order the provider files them. */
export function loadCorpus(path) {
  const byCtx = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [ctx, turns] = Object.entries(JSON.parse(line))[0];
    byCtx.set(
      ctx,
      splitSessions(turns).map(formatSession).filter(Boolean),
    );
  }
  return byCtx;
}

// ── locating a quote ──────────────────────────────────────────────────────────

/** Typographic characters a model silently rewrites when it copies. One-for-one, so offsets hold. */
const fold = (s) =>
  s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Whitespace-collapsed text plus, per output character, the offset it came from. */
export function normalizeWithMap(text) {
  const chars = [];
  const map = [];
  let prevWs = true; // true at the start, so leading whitespace is dropped
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!prevWs) {
        chars.push(" ");
        map.push(i);
        prevWs = true;
      }
    } else {
      chars.push(c);
      map.push(i);
      prevWs = false;
    }
  }
  if (chars.at(-1) === " ") {
    chars.pop();
    map.pop();
  }
  return { text: fold(chars.join("")), map };
}

/**
 * Where in `doc` the quote came from: exact first, then whitespace-normalized, then the longest
 * prefix of the quote that still lands somewhere. Returns null when nothing does.
 *
 * ponytail: prefix-shrinking rather than a real longest-common-substring. It costs nothing and
 * catches the failure that actually occurs (a model drops or rewrites the tail of a long quote);
 * an LCS is worth writing only if the match rate says so.
 */
export function locate(doc, quote, normalized) {
  const exact = doc.indexOf(quote);
  if (exact !== -1) return { offset: exact, how: "exact" };
  const nd = normalized ?? normalizeWithMap(doc);
  const nq = normalizeWithMap(quote).text;
  if (!nq) return null;
  const hit = nd.text.indexOf(nq);
  if (hit !== -1) return { offset: nd.map[hit], how: "normalized" };
  for (let len = nq.length - 1; len >= MIN_PARTIAL_CHARS; len = Math.floor(len * 0.9)) {
    const at = nd.text.indexOf(nq.slice(0, len));
    if (at !== -1)
      return { offset: nd.map[at], how: `partial:${len}/${nq.length}` };
  }
  return null;
}

/** `raw:00003-abc.md — "…"` → the file's index and the quote. Null when the record has no source. */
export function parseSource(attrs) {
  const src = String(attrs?.sources ?? "");
  const m = /^raw:(\d+)-[^\n]*?\.md\s+—\s+"([\s\S]*)"\s*$/.exec(src.trim());
  if (!m) return null;
  return { docIndex: Number(m[1]), quote: m[2] };
}

// ── the run ───────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const dryRun = args.includes("--dry-run");
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) positional.push(args[i]);
    else if (args[i] !== "--dry-run") i++; // skip the flag's value
  }
  const db = positional[0];
  const corpus = flag("corpus");
  const ns = flag("ns") ?? null;
  const baseMs = Date.parse(`${flag("base", "2025-01-01")}T00:00:00.000Z`);
  if (!db || !corpus || Number.isNaN(baseMs)) {
    console.error(
      "usage: node bench/backfill-ordinal-dates.mjs <store.db> --corpus <shared_contexts_32k.jsonl> --ns <context id> [--dry-run] [--base YYYY-MM-DD]",
    );
    return 2;
  }

  const docs = loadCorpus(corpus).get(ns);
  if (!docs)
    throw new Error(
      `no context '${ns}' in ${corpus}. The ns is the PersonaMem shared_context_id: sqlite3 ${db} "select distinct ns from entities"`,
    );
  const normalized = docs.map((d) => normalizeWithMap(d));

  const { restampOccurredAt } = await import("../dist/core/backfill.js");
  const { openStore } = await import("../dist/front/store.js");
  const store = await openStore({ db }, process.env);

  const unmatched = [];
  const examples = [];
  const counts = { exact: 0, normalized: 0, partial: 0, nosource: 0 };

  const { scanned, changes } = await restampOccurredAt(
    store,
    (e) => {
      const parsed = parseSource(e.attributes);
      if (!parsed) {
        // The person anchor and anything else the connector did not extract from a quote. Not a
        // miss — there is no source to match — so it is counted apart from the failures.
        counts.nosource++;
        return null;
      }
      const doc = docs[parsed.docIndex];
      if (doc === undefined) {
        unmatched.push({ id: e.id, why: `no document ${parsed.docIndex}`, quote: parsed.quote });
        return null;
      }
      const found = locate(doc, parsed.quote, normalized[parsed.docIndex]);
      if (!found) {
        unmatched.push({ id: e.id, why: `quote not in doc${parsed.docIndex}`, quote: parsed.quote });
        return null;
      }
      counts[found.how.startsWith("partial") ? "partial" : found.how]++;
      const to = ordinalDate(parsed.docIndex, found.offset, doc.length, baseMs);
      if (examples.length < 3)
        examples.push({
          id: e.id,
          doc: parsed.docIndex,
          offset: found.offset,
          how: found.how,
          date: to,
          quote: parsed.quote.slice(0, 90),
        });
      return to;
    },
    { ns, dryRun },
  );

  for (const c of changes)
    console.log(`${c.id}  ${c.from} -> ${c.to}${dryRun ? "  (dry run)" : ""}`);
  for (const u of unmatched)
    console.log(`UNMATCHED ${u.id}  ${u.why}  ${JSON.stringify(u.quote.slice(0, 90))}`);

  const matched = counts.exact + counts.normalized + counts.partial;
  const withSource = matched + unmatched.length;
  const distinct = new Set(changes.map((c) => c.to)).size;
  const days = new Set(changes.map((c) => c.to.slice(0, 10))).size;
  console.log(
    `\nscanned ${scanned} (${counts.nosource} carry no quote), matched ${matched}/${withSource}` +
      ` (exact ${counts.exact}, normalized ${counts.normalized}, partial ${counts.partial}),` +
      ` ${dryRun ? "would restamp" : "restamped"} ${changes.length},` +
      ` ${distinct} distinct instants across ${days} days`,
  );
  if (examples.length) {
    console.log("\nexamples:");
    for (const x of examples)
      console.log(
        `  doc${x.doc} @${x.offset} (${x.how}) -> ${x.date}  ${JSON.stringify(x.quote)}`,
      );
  }
  return 0;
}

// Importable by the test without running: the pure half above is what it asserts on.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err?.message ?? err));
      process.exit(1);
    },
  );
}
