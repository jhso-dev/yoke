// inject — context injection (KNOWLEDGE-POLICY soft rule 5: inject strictly).
// search → compute effectiveStatus → by default only verified passes (stale/draft/deprecated excluded).
// The citation format is the smallest unit of the audit trail — pinned by tests.

import type { StoragePort } from "../ports/storage.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

export interface InjectItem {
  entity: Entity;
  effectiveStatus: Status;
  citation: string;
}

/** `[{type}:{id}@v{version}] {actor}, {occurred_at}` — the audit citation format. */
export function citation(e: Entity): string {
  return `[${e.type}:${e.id}@v${e.version}] ${e.provenance.actor}, ${e.provenance.occurred_at}`;
}

/**
 * Returns the verified knowledge matching a query, each with its citation.
 * @param includeDraft also include drafts (the label is carried by effectiveStatus). stale/deprecated are always excluded.
 * @param scope an entity id — the shared-working-context mechanism (persona is the person-shaped
 *   instance). Scope PRIORITIZES, it does not imprison:
 *   - scope + query: the full query results, with knowledge one relation hop from the scope entity
 *     ordered first — the working context leads, org-wide knowledge still flows in.
 *   - scope, no query: only the one-hop set (a briefing of that working context).
 *   The scope entity itself is never returned. The same verified/draft/ns filters apply, and
 *   `limit` is applied after ordering/filtering.
 */
export async function inject(
  port: StoragePort,
  ontology: TypeDef[],
  query: string,
  now: string,
  opts?: {
    includeDraft?: boolean;
    limit?: number;
    ns?: string | null;
    scope?: string;
  },
): Promise<{ items: InjectItem[] }> {
  const scope = opts?.scope;
  const ns = normalizeNs(opts?.ns);
  let candidates: Entity[];
  if (scope) {
    // One relation hop, both directions → the other-end entity ids (never the scope itself).
    const hopIds = new Set<string>();
    for (const r of await port.neighbors(scope)) {
      const other: string = r.from === scope ? r.to : r.from;
      if (other !== scope) hopIds.add(other);
    }
    if (query) {
      // Full query results, scope-linked ones first (stable partition) — the
      // working context leads, org-wide matches still included.
      const hits = await port.search({ text: query, ns: opts?.ns });
      candidates = [
        ...hits.filter((e) => hopIds.has(e.id)),
        ...hits.filter((e) => !hopIds.has(e.id)),
      ];
    } else {
      // No query: a briefing of the working context — the hop set only.
      candidates = [];
      for (const id of hopIds) {
        const e = await port.getEntity(id);
        // ns is not a point-read filter (getEntity is id-based), so enforce it here to match search().
        if (e && normalizeNs(e.ns) === ns) candidates.push(e);
      }
    }
  } else {
    candidates = await port.search({
      text: query,
      limit: opts?.limit,
      ns: opts?.ns,
    });
  }
  const items: InjectItem[] = [];
  for (const entity of candidates) {
    const status = effectiveStatus(entity, ontology, now);
    const pass =
      status === "verified" || (opts?.includeDraft && status === "draft");
    if (!pass) continue;
    items.push({ entity, effectiveStatus: status, citation: citation(entity) });
  }
  // Scope path caps after filtering; the non-scope path already capped in search().
  const limited =
    scope && opts?.limit !== undefined ? items.slice(0, opts.limit) : items;
  return { items: limited };
}
