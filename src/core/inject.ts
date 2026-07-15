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
 * @param scope an entity id — when set, restrict the candidate set to knowledge one relation hop from
 *   the scope entity (the generic "shared working context" mechanism; persona is the person-shaped
 *   instance). The scope entity itself is never returned. With a non-empty query too, the hop set is
 *   intersected with the query's search hits (by id). The same verified/draft/ns filters apply, and
 *   `limit` is applied after filtering (the hop set is small — no reason to cap it early).
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
    const otherIds = new Set<string>();
    for (const r of await port.neighbors(scope)) {
      const other: string = r.from === scope ? r.to : r.from;
      if (other !== scope) otherIds.add(other);
    }
    // With a query, intersect the hop set with the query's search hits by id (simplest correct match).
    let queryIds: Set<string> | null = null;
    if (query) {
      const hits = await port.search({ text: query, ns: opts?.ns });
      queryIds = new Set(hits.map((e) => e.id));
    }
    candidates = [];
    for (const id of otherIds) {
      if (queryIds && !queryIds.has(id)) continue;
      const e = await port.getEntity(id);
      // ns is not a point-read filter (getEntity is id-based), so enforce it here to match search().
      if (e && normalizeNs(e.ns) === ns) candidates.push(e);
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
