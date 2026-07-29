// storage port — the backend contract defined by core (exactly the StoragePort from SPEC.md).
// Adapters (SQLite, vector/graph DBs) implement it and must pass the conformance suite.
// There is deliberately no physical-delete API — knowledge is append-only.

import type { Entity, Relation } from "../core/types.js";

/** A keyword (FTS) query. text is required; the rest are optional filters. */
export interface TextQuery {
  text: string;
  type?: string;
  status?: string;
  limit?: number;
  /** Tenant namespace filter (PLAN-V2 10.1). Omitted/undefined = the default shared
   * namespace; a value scopes results to that namespace only. Point reads (getEntity)
   * stay id-based — ids are globally unique ULIDs, so no ns check is needed there. */
  ns?: string | null;
}

/**
 * An enumeration query. Every field is optional; ordering is ALWAYS ascending by id.
 * Enumeration is the only port method that can return the whole database, so its contract is
 * tighter than the rest (SPEC "Storage Port"): namespace-scoped, latest-version only, totally
 * ordered, and with a cursor that cannot skip or duplicate a row.
 */
export interface ListQuery {
  /** Tenant namespace filter. Omitted/null = the default shared namespace ONLY — never "every
   * namespace". A listing that defaults to all tenants is a leak by construction. */
  ns?: string | null;
  /** Entity type on listEntities, relation type on listRelations. Doubles as the RBAC key the
   * front tier passes to authorize(). */
  type?: string;
  /** Stored status. 'stale' is computed at read time and never persisted (see lifecycle), so it is
   * not a valid value here — callers apply effectiveStatus() to the rows they get back. */
  status?: string;
  /** Exclusive keyset cursor: only rows with id > after. Ids are ULIDs, so lexicographic order is
   * creation order — no sort column and no OFFSET scan. */
  after?: string;
  /** Max rows in this page. Omitted = every matching row, and next is null. */
  limit?: number;
}

/** One keyset page. */
export interface Page<T> {
  items: T[];
  /** Cursor to pass as ListQuery.after for the next page; null on the last page. Non-null ONLY
   * when more rows actually exist — adapters over-read by one rather than inferring "more" from
   * items.length === limit, so a caller can report truncation honestly instead of guessing. */
  next: string | null;
}

/**
 * Turn an over-read result set into a Page. Adapters fetch `limit + 1` rows and hand them here, so
 * `next` reflects a row that actually exists instead of the guess `items.length === limit`. It
 * lives with the contract rather than in each adapter because "next is truthful" is a contract
 * clause — four separate implementations would be four chances to get it subtly wrong.
 */
export function page<T extends { id: string }>(
  rows: T[],
  limit?: number,
): Page<T> {
  if (limit === undefined || rows.length <= limit)
    return { items: rows, next: null };
  const items = rows.slice(0, limit);
  return { items, next: items[items.length - 1].id };
}

export interface StoragePort {
  /** Prepare the backend (create schema, etc.). Must be idempotent. */
  init(): Promise<void>;
  /** Release resources. */
  close(): void;

  /** append-only: add an (id, version) row. Never modify existing rows. */
  putEntity(e: Entity): Promise<void>;
  /** Latest version when version is omitted, the given version otherwise. null if absent. */
  getEntity(id: string, version?: number): Promise<Entity | null>;

  putRelation(r: Relation): Promise<void>;
  /** Relations connected to id. Both directions when dir is omitted; filter type with relType. */
  neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]>;

  /** Keyword (FTS) search. Empty array on no match. */
  search(q: TextQuery): Promise<Entity[]>;

  /** Enumerate latest-version entities, ascending by id. */
  listEntities(q: ListQuery): Promise<Page<Entity>>;
  /** Enumerate latest-version relations, ascending by id. q.type filters the relation type. */
  listRelations(q: ListQuery): Promise<Page<Relation>>;

  /** Optional capability — without it, core falls back to keyword search. */
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>;
}
