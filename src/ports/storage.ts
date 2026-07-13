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

  /** Optional capability — without it, core falls back to keyword search. */
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>;
}
