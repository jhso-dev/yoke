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

import { readEntities, type StoragePort } from "../ports/storage.js";
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
 * Both ENDS are filtered, not just the edge. The edge's own `ns` was the only check, and an edge is
 * filed with one namespace while its endpoints carry their own: a `same_as` filed in the default
 * namespace naming another tenant's person put that tenant's entity id into the union — printed in the
 * exported SKILL.md's "Identity union" line, which is a foreign id in a document about someone else.
 * No knowledge crossed (inject re-filters candidates one layer down) and the identity did, which is the
 * hole `personaQuery`'s own ns check exists to close, arriving through the other door. Costs one batch
 * read per frontier, and only on the frontiers a union actually has.
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
    const candidates = edges
      .filter((r) => normalizeNs(r.ns) === wantNs)
      .map((r) => (r.from === current ? r.to : r.from))
      .filter((other) => !seen.has(other))
      .sort();
    // The endpoint records themselves, filtered by ns. An id that resolves to nothing drops out too:
    // a dangling endpoint is not a record of this person in this namespace, which is the question.
    const inNs = new Set(
      (await readEntities(port, candidates))
        .filter((e) => normalizeNs(e.ns) === wantNs)
        .map((e) => e.id),
    );
    const next = candidates.filter((id) => inNs.has(id));
    for (const other of next) {
      seen.add(other);
      out.push(other);
      queue.push(other);
    }
  }
  return out;
}
