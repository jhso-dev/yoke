import { parseInstant } from "../core/commit.js";
// The caller-supplied values every front adapter has to judge the same way.
//
// A rule implemented twice gets two answers. `Number("0x10")` is 16 and `/^\d+$/` refuses it, so a
// hex limit was honoured over HTTP and refused at the terminal — one product with two contracts. The
// same split let `?status=stale` and `?type=nonsense` answer with `[]`, which reads as "none exist"
// rather than "that is not a thing you can ask for".
//
// Each tier maps the reason to its own shape (a UsageError and exit 1, or a 400), so nothing here
// knows how a refusal is delivered.

import type { TypeDef } from "../core/ontology.js";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The stored values of `status`. `stale` is NOT among them — it is computed at read time. */
export const STORED_STATUSES = ["verified", "deprecated"] as const;

/** A whole number at or above `min`. Digits only: `Number()` also takes `0x10`, `1e3`, `Infinity`
 *  and surrounding whitespace, and nobody typed any of those on purpose. */
export function wholeNumber(
  raw: string,
  label: string,
  min = 1,
): Checked<number> {
  const t = raw.trim();
  if (!/^\d+$/.test(t))
    return {
      ok: false,
      error: `${label} must be a whole number (got "${raw}")`,
    };
  const n = Number(t);
  if (n < min)
    return { ok: false, error: `${label} must be at least ${min} (got ${n})` };
  return { ok: true, value: n };
}

/**
 * A `status` filter, or why the value cannot match.
 *
 * `stale` is computed at read time and never stored, so pushing it to a query matches no row and
 * reads as "none are stale" — the opposite of the truth. An unregistered value (`bogus`, `DRAFT`) is
 * equally silent and indistinguishable from an empty corpus. Both are refused rather than answered
 * with emptiness: the stale case gets the command that does answer it, the others get the values
 * that exist.
 */
export function storedStatus(raw: string): Checked<string> {
  if (raw === "stale")
    return {
      ok: false,
      error:
        "stale is computed at read time, not stored, so no filter can match it — " +
        "'yoke review' is the queue of verified records past their TTL",
    };
  if (!STORED_STATUSES.includes(raw as (typeof STORED_STATUSES)[number]))
    return {
      ok: false,
      error: `status must be one of ${STORED_STATUSES.join(", ")} (got "${raw}")`,
    };
  return { ok: true, value: raw };
}

/** A declared type name, or a refusal listing the ones that exist — a typo and an empty corpus must
 *  not produce identical output. */
export function declaredType(
  raw: string,
  ontology: TypeDef[],
): Checked<string> {
  if (!ontology.some((t) => t.name === raw))
    return {
      ok: false,
      error: `unknown type: ${raw}\ndeclared types: ${ontology.map((t) => t.name).join(", ")}`,
    };
  return { ok: true, value: raw };
}

/**
 * A caller error, as distinct from a failure: an argument or an environment variable that cannot be
 * acted on. Thrown by the argument readers below and by store resolution (`front/store.ts`), and
 * caught once at the dispatcher, which prints the message alone and exits 1.
 *
 * Named so that one catch can tell "you typed something I cannot act on" from "something broke",
 * because the two deserve different sentences and only one of them is the reader's to fix. The
 * dispatcher decorates a FAILURE with the database it happened to; a refusal already names what to
 * change, and prefixing it with a file the reader never mistyped sends them to the wrong place.
 */
export class UsageError extends Error {}

/**
 * A numeric flag, or a refusal naming what was wrong with it.
 *
 * `Number(v.x)` answers a DIFFERENT question rather than declining the one asked: NaN compares false
 * against everything, so an unparseable number does not fail — it quietly changes the answer (a
 * `--limit` that reaches SQL as a datatype mismatch, a `--depth` that walks zero hops). A count is
 * written in digits, so `0x10` parsing as 16 while `3.7` errors is the same objection: reject
 * anything that is not all digits.
 */
export function intFlag(
  raw: string | undefined,
  name: string,
  min = 1,
): number | undefined {
  if (raw === undefined) return undefined;
  const r = wholeNumber(raw, `--${name}`, min);
  if (!r.ok) throw new UsageError(r.error);
  return r.value;
}

/**
 * A timestamp flag, or a refusal — returned NORMALIZED to UTC ISO 8601, never as typed.
 *
 * An unvalidated instant reaches `Date.parse`, which yields NaN on garbage; every comparison against
 * NaN is false, so `versionAsOf` keeps the latest version while `isFresh` reports everything expired
 * — a plausible-looking history of a moment that does not exist. A question about the past is the one
 * whose answer a reader cannot sanity-check, so the instant has to be real before it is used.
 *
 * Normalized here, at the boundary, because the comparisons below do not agree on how to read offset
 * notation: TS paths parse it, but the SQL paths (`exportUntil`, `listAudit`) compare strings against
 * stored `...Z` stamps, where `2026-08-13T20:00:00-09:00` sorts BEFORE every 2026-08-14 row it is
 * actually after. Canonicalizing once is the only way the two agree.
 */
export function instantFlag(
  raw: string | undefined,
  name: string,
): string | undefined {
  if (raw === undefined) return undefined;
  // Delegate to the core parser — the ONE strict ISO-8601 instant reader (CLAUDE.md: the second place
  // that parses calls the first). `Date.parse` accepts `2026-02-30`, `"2026-08-14 00:00:00"` and `"0"`,
  // which a strict reader must not. `parseInstant` rejects them and returns the canonical UTC string;
  // its Error is rethrown as a UsageError naming the flag.
  try {
    return parseInstant(raw);
  } catch {
    throw new UsageError(
      `--${name} must be an ISO 8601 instant, e.g. 2026-08-13T00:00:00Z (got "${raw}")`,
    );
  }
}

/**
 * Refuse the arguments a command cannot use, naming them.
 *
 * An extra positional a command silently drops is worse than an error: `yoke inject cache sessions`
 * would answer the query "cache" and write "cache" into the audit trail, so the reader believes they
 * asked something they did not, and the trail agrees with them. Quote a phrase to pass it as one value.
 */
export function noExtra(
  positionals: string[],
  keep: number,
  usage: string,
): void {
  if (positionals.length > keep)
    throw new UsageError(
      `unexpected argument: ${positionals
        .slice(keep)
        .map((p) => `"${p}"`)
        .join(" ")}` + `\nquote a phrase to pass it as one value\n${usage}`,
    );
}
