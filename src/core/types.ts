// yoke core types — the Entity/Relation/Provenance contract from SPEC.md.
// No logic here. This file exists to enforce, at the type level, that id/status/version/
// last_confirmed are assigned only by the commit gate (Input and stored shapes are split).

/** Knowledge status. Enters as draft, promoted by verify, ages to stale or is retired to deprecated. */
export type Status = "draft" | "verified" | "stale" | "deprecated";

/** Provenance of a piece of knowledge. The smallest unit of the audit trail. Dates are ISO 8601 strings (never store Date objects). */
export interface Provenance {
  /** person entity id or agent identifier (required) */
  actor: string;
  /** 'cli' | 'mcp' | 'connector:github-pr' | ... */
  origin: string;
  /** ISO 8601 */
  occurred_at: string;
}

/** Storage-only fields assigned by the gate. Absent from Input. */
interface Governed {
  /** ULID. Consumers must treat it as an opaque string. */
  id: string;
  status: Status;
  /** Starts at 1. Edits append a new version row (never overwrite). */
  version: number;
  /** ISO 8601. Refreshed on verify. */
  last_confirmed: string;
  provenance: Provenance;
}

/** The entity input shape commit accepts. No gate-assigned fields. */
export interface EntityInput {
  /** Entity type registered in the ontology (commit rejects unregistered types). */
  type: string;
  /** Validated against the ontology's per-type schema. */
  attributes: Record<string, unknown>;
}

/** A stored entity. The product of passing the gate. */
export interface Entity extends EntityInput, Governed {
  /** For duplicate detection and semantic search (sqlite-vec). */
  embedding?: Float32Array;
}

/** The relation input shape commit accepts. Entity input plus direction. */
export interface RelationInput extends EntityInput {
  /** entity id (from) */
  from: string;
  /** entity id (to) */
  to: string;
}

/** A stored relation. Same skeleton as an entity plus direction. A relation is itself knowledge. */
export interface Relation extends RelationInput, Governed {}
