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
