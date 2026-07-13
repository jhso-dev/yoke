// inject — context injection (KNOWLEDGE-POLICY soft rule 5: inject strictly).
// search → compute effectiveStatus → by default only verified passes (stale/draft/deprecated excluded).
// The citation format is the smallest unit of the audit trail — pinned by tests.

import type { StoragePort } from "../ports/storage.js";
import { effectiveStatus } from "./lifecycle.js";
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
 */
export async function inject(
  port: StoragePort,
  ontology: TypeDef[],
  query: string,
  now: string,
  opts?: { includeDraft?: boolean; limit?: number },
): Promise<{ items: InjectItem[] }> {
  const results = await port.search({ text: query, limit: opts?.limit });
  const items: InjectItem[] = [];
  for (const entity of results) {
    const status = effectiveStatus(entity, ontology, now);
    const pass =
      status === "verified" || (opts?.includeDraft && status === "draft");
    if (!pass) continue;
    items.push({ entity, effectiveStatus: status, citation: citation(entity) });
  }
  return { items };
}
