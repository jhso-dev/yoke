// Presentation shared by the two front adapters. Not core: core deals in records, and how a record
// reads to a person is a front-tier concern (CLAUDE.md invariant 1 — core imports no adapter, and this
// imports only core types).
//
// This file exists because there were two copies of summarize(). The CLI's had a bug fix the web's did
// not — connector-ingested rows summarised as their idempotency key ("rdb:table:1") instead of their
// knowledge — so every web screen showed the defect the CLI had already fixed. One copy, one fix.

import type { TypeDef } from "../core/ontology.js";

/** Keys that are bookkeeping, never the knowledge. A connector puts external_id first. */
const NOT_CONTENT = new Set([
  "external_id",
  "author",
  "topic",
  "key",
  "status",
]);

/**
 * The compact one-line reading of a record, ≤60 chars.
 *
 * Attribute ORDER is caller-controlled, so "first string value" is not good enough: a decision
 * committed as `{topic, conclusion, rationale}` summarised as its topic, which made three unrelated
 * decisions all read "caching". The ontology already declares which attributes matter, so a REQUIRED
 * string attribute wins when the type has one — `decision.conclusion` beats an undeclared `topic`
 * whatever order they were written in.
 *
 * Falls back to the first string that is not bookkeeping, then to "".
 */
export function summarize(
  entity: { type: string; attributes: Record<string, unknown> },
  ontology: TypeDef[],
): string {
  const def = ontology.find((t) => t.name === entity.type);
  if (def) {
    for (const [key, spec] of Object.entries(def.attrs)) {
      if (!spec.required || spec.type !== "string") continue;
      const val = entity.attributes[key];
      if (typeof val === "string" && val) return val.slice(0, 60);
    }
  }
  for (const [key, val] of Object.entries(entity.attributes)) {
    if (NOT_CONTENT.has(key)) continue;
    if (typeof val === "string" && val) return val.slice(0, 60);
  }
  // Everything was bookkeeping: better to show it than to render nothing at all.
  for (const val of Object.values(entity.attributes)) {
    if (typeof val === "string" && val) return val.slice(0, 60);
  }
  return "";
}
