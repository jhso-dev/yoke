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
  /** The record's own `role` attribute, when it has one (person entities do). Sent so the persona
   * roster can label a card by the person's role, not by who seeded the roster row (the steward). */
  role?: string;
  occurred_at: string;
  /** `[type:id@vN] actor, occurred_at` — built by core, never reassembled here. */
  citation: string;
}

/**
 * An injected row, which may carry what it contradicts.
 *
 * Present only when the record has a live `conflicts_with` edge, so absent means "not disputed" rather
 * than "not checked". Both sides are always injected — the policy is that contradictions are surfaced
 * and never auto-resolved, so the screen's job is to say so, not to pick.
 */
export interface InjectedKnowledge extends Knowledge {
  conflictsWith?: string[];
  /** Who actually WROTE this, off the `authored_by` edge — resolved to `authorName` for reading.
   * `actor`/`actorName` above name the PROMOTER (a verified record's provenance is its promotion), so
   * when the two differ the writer is here and the citation string is rebuilt to name them. Absent when
   * the record has no authorship edge, in which case the promoter is the only actor there is. */
  author?: string;
  authorName?: string;
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

/**
 * What matched but could not be injected, by reason — core's `WithheldStats`, mirrored.
 *
 * Shared by the inject preview and the persona screen so the two describe the same fact the same way.
 * `structural` is always 0 on a persona (`personaQuery` zeroes it), present here only to match the
 * one shape the server sends.
 */
export interface Withheld {
  draft: number;
  stale: number;
  deprecated: number;
  structural: number;
  /** Verified, but something recorded as replacing it exists. Settled, unlike a conflict — so the
   * record is withheld rather than marked, and the replacement answers on its own merits. */
  superseded: number;
}

/** One identity record a persona unioned (`same_as`). `name` is resolved server-side; `id` is kept so
 * a reader can check the merge, on hover/copy — never rendered as the readable text. */
export interface PersonaIdentity {
  id: string;
  name: string;
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
  /** Present only on a retired record: who retired it, when, and why if anyone said. Read back from
   * the audit trail — verify/deprecate change status, never knowledge content, so the reason is a
   * property of the ACT rather than of the record. */
  retirement?: {
    actor: string;
    /** The retiree resolved for reading; absent for a machine actor or an unresolvable id. Render
     * `actorName ?? actor` and keep the id reachable, the same rule the row's own actor follows. */
    actorName?: string;
    at: string;
    reason?: string;
  };
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
  /** True when the edge means the same thing read either way (`relates_to`, `conflicts_with`,
   * `same_as`). The link control then does not offer a direction, because there is nothing to
   * choose: core treats either way round as one edge. */
  symmetric?: boolean;
  /** A roster edge, not knowledge. Core skips these when it builds an anchored briefing; the graph
   * draws them as not-knowledge for the same reason. */
  membership?: boolean;
  /** A type that names what knowledge is attached to (`person`, `collaboration`) rather than
   * asserting anything. Core never injects these as knowledge; the seed search does not offer
   * them as seeds for the same reason. */
  structural?: boolean;
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
  /** Why, on a governance act that carries a reason — the deprecate route writes it and the audit
   * route emits it verbatim (`...e`). Absent on every other action. */
  note?: string;
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
  /** What matched but was held back, and why — non-null whenever something matched and at least one
   * match was withheld, whether or not anything came through (measured: `items:1, withheld:{draft:1}`).
   * Null means nothing was held back — either the query matched nothing, or everything it matched was
   * injected. So a full table can still carry this: it names the records the page is NOT everything of. */
  withheld: Withheld | null;
  items: InjectedKnowledge[];
}

/** GET /api/review?stale=1. Verified records past their type's TTL.
 *
 * `scanned` is not decoration: freshness is computed at read time from the ontology's TTL, so finding
 * these is a bounded walk over verified rows rather than an indexed query. The screen has to say what
 * the walk covered, because "12 stale" alone reads as a corpus-wide count it never computed. */
export interface StaleQueue extends Page<Knowledge & { injections: number }> {
  scanned: number;
}

export interface Persona {
  /** `InjectedKnowledge`, because a persona row can be disputed like any other injected one — both
   * sides of a `conflicts_with` are returned and the screen's job is to say so, not to pick. */
  decisions: InjectedKnowledge[];
  facts: InjectedKnowledge[];
  /** What this person has on record but this document does NOT contain, by reason. Present only when
   * something of theirs was held back — the difference between "everything in review" and "nothing on
   * record", which without it render byte-identically (the CLI and MCP both surface it). */
  withheld?: Withheld;
  /** The identity records this persona combined (`same_as`), present only when more than one. A
   * same_as link is an unreviewed claim, so the screen must disclose that N identities were merged. */
  identities?: PersonaIdentity[];
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
