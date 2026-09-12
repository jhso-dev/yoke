// yoke core types — the Entity/Relation/Provenance contract from SPEC.md.
// No logic here. This file exists to enforce, at the type level, that id/status/version/
// last_confirmed are assigned only by the commit gate (Input and stored shapes are split).

/** Knowledge status. Born verified — filing under a signed actor IS the entry bar — then ages to
 * stale past its TTL or is retired to deprecated. verify() re-confirms: it refreshes the lease. */
export type Status = "verified" | "stale" | "deprecated";

/** Provenance of a piece of knowledge. The smallest unit of the audit trail. Dates are ISO 8601 strings (never store Date objects). */
export interface Provenance {
  /** person entity id or agent identifier (required) */
  actor: string;
  /** 'cli' | 'mcp' | 'connector:github-pr' | ... */
  origin: string;
  /** ISO 8601. WHEN THE KNOWLEDGE HAPPENED — what the source said, not when we wrote it down.
   * A lifecycle transition carries this forward unchanged (see lifecycle.transition): promoting a
   * record does not move when its source said it. */
  occurred_at: string;
  /** ISO 8601. When THIS VERSION came into being, if a lifecycle transition wrote it — governance
   * time, which is not the knowledge's event time. Written only by lifecycle.transition; the commit
   * gate STRIPS a caller-supplied one (`normalizeProvenance`), because this is what the as-of rewind
   * reads. Absent on every commit-written row, and on lifecycle rows written before the two times
   * were separated (those carry the transition instant in `occurred_at`, the defect this fixes). */
  transitioned_at?: string;
  /** Why this version retired the record, in the actor's words. Written only by `lifecycle.deprecate`
   * and only when someone typed one; the gate strips it, and a later transition does not carry it
   * forward (a re-verified record has no retirement to explain). On the record rather than on the
   * audit trail because the trail's location depends on the deployment — one server, or one sqlite
   * per client — and the reason a decision died must not. Absent means nobody wrote one. */
  reason?: string;
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
  /** Tenant namespace (ENTERPRISE "namespaces"). Absent/undefined = the default shared namespace.
   * Assigned by the gate; parsed/composed only by core/namespace.ts. */
  ns?: string;
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
