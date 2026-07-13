// lifecycle — status transitions and freshness (KNOWLEDGE-POLICY soft rules 4 & 7).
// verify/deprecate change status, not knowledge content, so they take a separate write
// path rather than the commit gate. The only direct putEntity calls live in this file.
// Time is injected — never call new Date() in core (SPEC: inject the clock).

import type { StoragePort } from "../ports/storage.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Shared transition path. Reads with getEntity, then appends a new version row (append-only).
 * Provenance is refreshed to record the promote/retire action itself (origin: 'lifecycle').
 */
async function transition(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  status: Status,
): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const id of ids) {
    const prev = await port.getEntity(id);
    // Do not silently skip unknown ids — promote/retire are explicit actions.
    if (!prev) throw new Error(`cannot transition unknown entity: ${id}`);
    const next: Entity = {
      ...prev,
      status,
      version: prev.version + 1,
      last_confirmed: now,
      provenance: { actor, origin: "lifecycle", occurred_at: now },
    };
    await port.putEntity(next);
    out.push(next);
  }
  return out;
}

/** status → 'verified', last_confirmed = now. Appends a new version row (append-only). */
export function verify(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "verified");
}

/** status → 'deprecated'. Same mechanism as verify (append-only new version). */
export function deprecate(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "deprecated");
}

/**
 * Freshness check. Always fresh if the type has no ttl_days.
 * Otherwise fresh while last_confirmed + ttl_days >= now (millisecond arithmetic, no deps).
 */
export function isFresh(e: Entity, ontology: TypeDef[], now: string): boolean {
  const ttl = ontology.find((t) => t.name === e.type)?.ttl_days;
  if (ttl === undefined) return true;
  return Date.parse(e.last_confirmed) + ttl * DAY_MS >= Date.parse(now);
}

/**
 * Status at read time. If verified but no longer fresh, reports 'stale' (never persisted).
 * Otherwise returns the stored status as-is.
 */
export function effectiveStatus(
  e: Entity,
  ontology: TypeDef[],
  now: string,
): Status {
  if (e.status === "verified" && !isFresh(e, ontology, now)) return "stale";
  return e.status;
}
