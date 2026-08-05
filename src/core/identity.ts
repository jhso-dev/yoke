// identity — one person, several records (v5.6). The resolution half of SPEC "Identity across sources".
//
// Two source systems describing the same colleague produce two `person` records, and nothing in the
// store says they are one person. An RDB read-mapping over `employees` and a second over `contractors`
// is the case that actually occurs; a manually filed person and a mapped one is the other. The
// consequence is not cosmetic — a persona is "knowledge sourced from a specific person", so a duplicate
// record silently splits that person's judgment in half, and the half that is missing looks like
// knowledge they never recorded.
//
// The link is KNOWLEDGE, not configuration: a `same_as` relation, filed through the ordinary gate by
// `yoke link <alias> same_as <canonical>`, versioned, attributable and reversible like every other
// claim. No fuzzy name matching anywhere — see the SPEC clause for why a heuristic merge is the one
// mistake this design will not make on a person's behalf.

import type { StoragePort } from "../ports/storage.js";
import { normalizeNs } from "./namespace.js";

/**
 * Every record that is the same person as `id`, including `id` itself.
 *
 * `same_as` is followed in BOTH directions and transitively: whoever files the link picks a direction
 * for readability (alias → canonical), and treating that direction as meaningful would make
 * `identitySet(alias)` and `identitySet(canonical)` two different answers about one person. Cycles and
 * diamonds are therefore expected input, not corruption, and the visited set is what makes them safe.
 *
 * Namespace-filtered before following, because `neighbors` takes no `ns` — without this, a `same_as`
 * filed in one tenant would pull another tenant's person into the set. The same reason inject filters
 * the vector half in core.
 *
 * Returns breadth-first from `id`, so the queried record comes first and the order is stable across
 * backends (`neighbors` guarantees no ordering, so each frontier is sorted).
 */
export async function identitySet(
  port: StoragePort,
  id: string,
  ns?: string | null,
): Promise<string[]> {
  const wantNs = normalizeNs(ns);
  const seen = new Set([id]);
  const out = [id];
  const queue = [id];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by queue.length
    const current = queue.shift()!;
    const edges = await port.neighbors(current, "same_as");
    const next = edges
      .filter((r) => normalizeNs(r.ns) === wantNs)
      .map((r) => (r.from === current ? r.to : r.from))
      .filter((other) => !seen.has(other))
      .sort();
    for (const other of next) {
      seen.add(other);
      out.push(other);
      queue.push(other);
    }
  }
  return out;
}
