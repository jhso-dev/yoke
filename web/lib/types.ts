// The client's view of the JSON API. Mirrors row() in src/front/ui/server.ts.
//
// `citation` and `effectiveStatus` are REQUIRED, not optional, and that is load-bearing: WEB-UI.md
// says every screen shows a record's source and version, and making the field non-optional turns
// that rule into a compile error instead of a review comment.

export type Status = "draft" | "verified" | "stale" | "deprecated";

/** One knowledge row, as every list endpoint returns it. */
export interface Knowledge {
  id: string;
  type: string;
  version: number;
  status: Status;
  /** Read-time status: 'stale' is computed by core and never stored, so this is the one to render. */
  effectiveStatus: Status;
  summary: string;
  /** The actor id as recorded — a person entity id or an agent identifier. */
  actor: string;
  /** The actor rendered for a human, resolved server-side. Absent for machine actors
   * ('yoke:system') and for person ids that no longer resolve, so render `actorName ?? actor`
   * and keep the id reachable — it is what the citation points at. */
  actorName?: string;
  occurred_at: string;
  /** `[type:id@vN] actor, occurred_at` — built by core, never reassembled here. */
  citation: string;
}

/** A relation row: a Knowledge row plus its endpoints. */
export interface Edge extends Knowledge {
  from: string;
  to: string;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface EntityDetail {
  entity: Knowledge & {
    attributes: Record<string, unknown>;
    last_confirmed: string;
    origin: string;
    ns?: string;
  };
  history: Knowledge[];
  relations: {
    out: (Edge & {
      dir: "out";
      other: Knowledge | { id: string; missing: true };
    })[];
    in: (Edge & {
      dir: "in";
      other: Knowledge | { id: string; missing: true };
    })[];
  };
}

export interface ConflictPair {
  id: string;
  from: Knowledge | { id: string; missing: true };
  to: Knowledge | { id: string; missing: true };
}

export interface TypeDef {
  name: string;
  kind: "entity" | "relation";
  attrs: Record<string, { type: string; required?: boolean }>;
  ttl_days?: number;
  /** A roster edge, not knowledge. Core skips these when it builds an anchored briefing; the graph
   * draws them as not-knowledge for the same reason. */
  membership?: boolean;
}

export interface AuditEntry {
  actor: string;
  /** Resolved for reading; the trail itself records only the id. */
  actorName?: string;
  action: string;
  /** As recorded: `<subject> -> <id> <id> …`. Never rewritten — it is the audit fact. */
  detail: string;
  /** The records `detail` names, resolved so the row can be read. Capped server-side; absent when
   * nothing resolved (every id deleted, or in another namespace). */
  refs?: { id: string; type: string; summary: string }[];
  at: string;
  ns?: string;
}

export interface TokenInfo {
  name: string;
  scopes: string[];
  created_at: string;
}

export interface CreatedToken extends TokenInfo {
  token: string;
}

export interface GraphData {
  anchor: string | null;
  nodes: Knowledge[];
  edges: Edge[];
  next: { nodes: string | null; edges: string | null };
  truncated: boolean;
  limit: number;
}

export interface InjectPreview {
  query: string;
  scope: string | null;
  includeDraft: boolean;
  /** How many records the limit dropped. >0 means this is a page, not the whole context. */
  omitted: number;
  items: Knowledge[];
}

export interface Persona {
  decisions: Knowledge[];
  facts: Knowledge[];
}

/** GET /api/meta — ungated, so the shell can decide whether to show a login before it has one. */
export interface Meta {
  auth: boolean;
  readOnly: boolean;
  ns: string | null;
  actor: string | null;
  /** The actor rendered for a human; absent for machine actors and unresolvable ids. */
  actorName?: string;
}

/** True when the other side of a relation could not be resolved in this namespace. */
export function isMissing(
  x: Knowledge | { id: string; missing: true },
): x is { id: string; missing: true } {
  return "missing" in x;
}
