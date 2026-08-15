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
  /**
   * How multi-term queries combine (SPEC search clause 8). Default `"auto"`: every term up to
   * `AND_TERM_LIMIT`, any term beyond it. `"all"` requires every term at any length.
   *
   * Exists for callers that are performing a LOOKUP rather than asking a question — the connector
   * idempotency probe searches for one exact `external_id` and then filters for it exactly, so
   * recall past that one row is pure cost. Measured at 1M entities, a GitHub comment URL as an
   * `"auto"` query: 292 ms and 1,000 materialized rows, against 34 ms and 0 under `"all"`.
   *
   * Deliberately not solved by a heuristic in the caller. Probing with "the id's most distinctive
   * tokens" drops the discriminator often enough to matter (`file:notes/2026-07-01.md#3` loses the
   * `#3`), and a lookup that silently misses re-ingests the record — the exact failure the probe
   * exists to prevent. Two callers want two semantics, so the query says which.
   */
  terms?: "auto" | "all";
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

/**
 * Order a batch read's rows by the ids that were asked for — the `getEntities` ordering clause, in
 * one place for the same reason `page()` is: four adapters obeying it separately is four chances to
 * get it subtly wrong, and this one is invisible when wrong (a reshuffled ranking still looks like a
 * ranking). Absent ids drop out; duplicates collapse, because Set iteration is insertion-ordered.
 */
export function orderByIds<T extends { id: string }>(
  rows: T[],
  ids: Iterable<string>,
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const id of new Set(ids)) {
    const r = byId.get(id);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Read many entities, using the backend's batch capability when it has one and the `getEntity` loop
 * when it does not. Callers in core use THIS rather than probing `getEntities` themselves — one copy
 * of the feature-detect, the same rule `listVersions` learned after `backfillAuthorship` grew its own
 * (and settled for the wrong fallback).
 *
 * Returns rows in `ids` order with absent ids omitted, on both paths.
 */
export async function readEntities(
  port: StoragePort,
  ids: Iterable<string>,
): Promise<Entity[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  if (port.getEntities) return port.getEntities(wanted);
  const out: Entity[] = [];
  for (const id of wanted) {
    const e = await port.getEntity(id);
    if (e) out.push(e);
  }
  return out;
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

  /**
   * Optional capability (v5.5) — the latest version of each id in ONE round trip.
   *
   * Exists because every read path in core is a loop of point reads, which costs nothing on sqlite
   * and is a network round trip per iteration on a remote backend (SPEC "Batch point reads"). Callers
   * use `readEntities(port, ids)` above rather than probing for this, so an adapter without it is
   * correct and merely slower — an in-process backend has nothing to gain.
   *
   * Contract: rows come back in `ids` ORDER (use `orderByIds`), absent ids are omitted rather than
   * returned as holes, and duplicate ids collapse to one row. There is deliberately no batch form
   * taking versions — the version walks stay loops, see the SPEC section.
   */
  getEntities?(ids: string[]): Promise<Entity[]>;

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

  /**
   * Per-database key/value metadata — facts about the STORE, not knowledge in it.
   *
   * Not namespaced and not versioned: a tenant does not get its own index format, and there is no
   * history to keep for a value whose only reader is the code that wrote it. `null` for an unset key,
   * which is how a database written before a key existed answers — so every reader must have a
   * legacy default rather than treating absence as an error.
   *
   * Today it holds exactly one key, `INDEX_KEY_META` (core/embedding): what the search index is keyed
   * on. That belongs to the database rather than to the process, because a process that guesses wrong
   * rewrites rows into a second representation and leaves a silently mixed index.
   */
  getMeta(key: string): Promise<string | null>;
  /** Set (or replace) a meta value. Overwriting is the point — see `getMeta`. */
  setMeta(key: string, value: string): Promise<void>;

  /** Enumerate latest-version entities, ascending by id. */
  listEntities(q: ListQuery): Promise<Page<Entity>>;
  /** Enumerate latest-version relations, ascending by id. q.type filters the relation type. */
  listRelations(q: ListQuery): Promise<Page<Relation>>;

  /** Optional capability — without it, core falls back to keyword search. */
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>;

  /**
   * Optional capability — index (or replace) the vector for `e.embedding`, keyed by `e.id`.
   *
   * **Not a knowledge write.** The embedding is a derived index like the FTS row: `entities` has no
   * vector column and only the latest version's vector is kept, so this creates no version and
   * changes no citation. That is what makes repairing coverage possible at all — `putEntity` cannot
   * be reused, because re-putting an existing `(id, version)` is a primary-key conflict.
   *
   * Reads `id`, `ns` and `embedding` only; everything else on the entity is ignored.
   *
   * `rebuild` drops the index before writing, which is the only way to change dimension: the index is
   * created with the first vector's width and every later vector must match it. Callers pass it on
   * the FIRST row of a backfill and never after, or each row would wipe the previous one.
   *
   * Optional, so a backend with no vector support is still conformant and callers feature-detect —
   * the same shape as `similar` and the `listHistory` extension. Every backend shipping today
   * implements it; the optionality is the extension point, not a description of the current set.
   */
  putEmbedding?(e: Entity, opts?: { rebuild?: boolean }): Promise<void>;
}
