// storage port — the backend contract defined by core (exactly the StoragePort from SPEC.md).
// Adapters (SQLite, vector/graph DBs) implement it and must pass the conformance suite.
// There is deliberately no physical-delete API — knowledge is append-only.

import type { Entity, Relation } from "../core/types.js";

/**
 * How many rows `search` returns when the caller names no limit.
 *
 * Not a product policy — `inject` and the front adapters have their own caps. This is the floor
 * that stops a forgotten `limit` from materializing the corpus: at 10M entities the unbounded call
 * built ten million row objects and the process died in `RowBuilder::GetRowJS` (docs/SCALE.md).
 * Generous enough that no existing caller changes behaviour, since nothing asked for more than the
 * front tier's 500.
 *
 * `listEntities` deliberately keeps the opposite default (unbounded): enumeration is a cursor walk
 * the caller drives to the end, search is a top-k the caller consumes.
 */
export const DEFAULT_SEARCH_LIMIT = 1000;

/** A keyword (FTS) query. text is required; the rest are optional filters. */
export interface TextQuery {
  text: string;
  type?: string;
  /** Stored status. An array means "any of these", which is what injection needs: it wants
   * verified, or verified-and-draft, and could not say so with a single value. Over-fetching instead
   * does not work — `verify` rewrites the row, so on tied relevance the injectable records sort LAST
   * and a 4x window can miss all of them (found by the test written to prove the opposite). */
  status?: string | string[];
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

  /**
   * Keyword (FTS) search. Empty array on no match.
   *
   * Two clauses tightened in v5.1, both conformance cases (SPEC "search"):
   * - **Best match first**, never storage order. An adapter with a ranker uses it; one without
   *   ranks the rows it already materialized (`core/rank.ts`). Returning insertion order makes
   *   `limit` mean "oldest N", which is what injection was silently doing.
   * - **Bounded when the caller omits `limit`**: `DEFAULT_SEARCH_LIMIT` applies. A resource bound,
   *   not a policy cap — an unbounded search at 10M entities exhausted the JS heap.
   *
   * `ns`, `type` and `status` filters apply BEFORE the limit.
   */
  search(q: TextQuery): Promise<Entity[]>;

  /** Enumerate latest-version entities, ascending by id. */
  listEntities(q: ListQuery): Promise<Page<Entity>>;
  /** Enumerate latest-version relations, ascending by id. q.type filters the relation type. */
  listRelations(q: ListQuery): Promise<Page<Relation>>;

  /** Optional capability — without it, core falls back to keyword search. */
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>;
}
