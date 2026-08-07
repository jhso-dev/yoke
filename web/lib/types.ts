// The client's view of the JSON API. Mirrors row() in src/front/ui/server.ts.
//
// `citation` and `effectiveStatus` are REQUIRED, not optional: every payload carries a record's
// source, so no screen can be missing the data. That is half of WEB-UI.md's "every screen shows a
// record's source and version"; the rendering half is not expressible in the type system and is
// enforced by `citation-render.test.ts`.

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

/** GET /api/search. `next` is always null — search is a top-N, not a paged walk of the corpus, so
 * `truncated` is how the screen learns the cap bit rather than a cursor it cannot follow. */
export interface SearchResult extends Page<Knowledge> {
  truncated: boolean;
  limit: number;
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
  /** The instant this was answered as of, or null for "now". Echoed back so the screen states which
   * clock produced the rows — a historical read that looked like a current one would be worse than
   * no feature at all. */
  asOf: string | null;
  includeDraft: boolean;
  /** How many records the limit dropped. >0 means this is a page, not the whole context. */
  omitted: number;
  /** What a multi-hop walk did — non-null only when depth > 1 was requested and walked. */
  walk: { depth: number; nodes: number; truncated: boolean } | null;
  items: Knowledge[];
}

/** GET /api/review?stale=1. Verified records past their type's TTL.
 *
 * `scanned` is not decoration: freshness is computed at read time from the ontology's TTL, so finding
 * these is a bounded walk over verified rows rather than an indexed query. The screen has to say what
 * the walk covered, because "12 stale" alone reads as a corpus-wide count it never computed. */
export interface StaleQueue extends Page<Knowledge> {
  scanned: number;
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
