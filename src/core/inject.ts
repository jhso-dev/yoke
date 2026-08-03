// inject — context injection (KNOWLEDGE-POLICY soft rule 5: inject strictly).
// search → compute effectiveStatus → by default only verified passes (stale/draft/deprecated excluded).
// The citation format is the smallest unit of the audit trail — pinned by tests.

import type { StoragePort } from "../ports/storage.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

export interface InjectItem {
  entity: Entity;
  effectiveStatus: Status;
  citation: string;
}

/**
 * The recommended default cap for an anchored briefing, for front adapters to apply.
 *
 * Core deliberately does NOT apply it: a budget belongs to the surface that pays it (an agent's
 * context window, a terminal, a screen), and applying it here would silently cap `personaQuery` too —
 * a persona that dropped someone's older judgment without saying so is the impersonation risk that
 * module exists to avoid. One number, one place, three callers.
 *
 * A cap is only honest because a briefing is not the only way in: the QUERY path searches the whole
 * namespace (scope only re-orders it), so knowledge past the cap is reached by asking about it. That
 * is why `omitted` must be surfaced with words telling the reader so — see the MCP renderer.
 */
export const BRIEFING_LIMIT = 50;

/**
 * What injection asks the store for, so the cap lands after the filter rather than before it.
 *
 * Two parts, and the first is the one that matters:
 *
 * `status` is pushed DOWN. Injection wants stored-verified rows (plus stored-draft when asked), and
 * `search` can now express that, so deprecated rows never occupy the window. Over-fetching alone was
 * tried and does not work: `verify` rewrites the FTS row, so on tied relevance the verified records
 * sort LAST, and a 4x window over a corpus with a review backlog can contain none of them. The test
 * written to prove over-fetching sufficient is what disproved it.
 *
 * The multiplier remains for the one filter that cannot be pushed: `stale` is computed from the
 * ontology's TTL at read time and is never stored (lifecycle.ts), so a stored-verified row may still
 * be dropped here. 3x covers a corpus where two thirds of verified knowledge has gone stale, and
 * when it does not the answer is a short page, not a silent one — `omitted` reports the shortfall.
 *
 * ponytail: fixed multiplier, no adaptive re-query. Add the second round trip when a real corpus is
 * measured returning short pages, not on the strength of this comment.
 */
const STALE_HEADROOM = 3;
const candidateQuery = (opts?: {
  includeDraft?: boolean;
  limit?: number;
  ns?: string | null;
}) => ({
  ns: opts?.ns,
  status: opts?.includeDraft ? ["verified", "draft"] : "verified",
  limit: opts?.limit === undefined ? undefined : opts.limit * STALE_HEADROOM,
});

/** `[{type}:{id}@v{version}] {actor}, {occurred_at}` — the audit citation format. */
export function citation(e: Entity): string {
  return `[${e.type}:${e.id}@v${e.version}] ${e.provenance.actor}, ${e.provenance.occurred_at}`;
}

/**
 * Returns the verified knowledge matching a query, each with its citation.
 * @param includeDraft also include drafts (the label is carried by effectiveStatus). stale/deprecated are always excluded.
 * @param scope an entity id to anchor the injection on — one mechanism with two named entry points:
 *   a collaboration anchor is the shared working context, a person anchor is a persona.
 *   - scope + query: the full query results, with knowledge one relation hop from the scope entity
 *     ordered first — the working context leads, org-wide knowledge still flows in (scope
 *     PRIORITIZES, it does not imprison).
 *   - scope, no query: only the one-hop set (a briefing of that anchor), ordered
 *     verified-first → most-recently-confirmed → id. That order is part of the contract: without it
 *     `limit` cuts by whatever order the backend happened to return relations in.
 *   The scope entity itself is never returned, and neither is anything reached only through a
 *   relation the ontology marks `membership` (a roster is not knowledge — pass that type as
 *   `scopeRel` to ask for it on purpose). The same verified/draft/ns filters apply, and
 *   `limit` is applied after ordering/filtering.
 * @param scopeRel @param scopeDir narrow the anchor walk, passed straight to port.neighbors.
 *   Default: every relation type, both directions — right for a collaboration, whose whole point is
 *   everything attached to the work. A persona passes authored_by/'in' instead: presenting knowledge
 *   a person merely touched as their own judgment would be impersonation, so the strict anchor is
 *   part of that entry point, not a different mechanism.
 */
export async function inject(
  port: StoragePort,
  ontology: TypeDef[],
  query: string,
  now: string,
  opts?: {
    includeDraft?: boolean;
    limit?: number;
    ns?: string | null;
    scope?: string;
    scopeRel?: string;
    scopeDir?: "in" | "out";
  },
): Promise<{ items: InjectItem[]; omitted: number }> {
  const scope = opts?.scope;
  const ns = normalizeNs(opts?.ns);
  let candidates: Entity[];
  if (scope) {
    // Relation types the ontology marks as membership. Walking them would hand the roster to an agent
    // as knowledge; who is involved in the work belongs on a screen, not in a briefing. Skipped only
    // when the caller did not ask for that type by name — `scopeRel: 'works_on'` is someone
    // deliberately asking for members, and this must not silently return nothing.
    const membership = new Set(
      ontology
        .filter((t) => t.kind === "relation" && t.membership)
        .map((t) => t.name),
    );
    // One relation hop → the other-end entity ids (never the scope itself).
    const hopIds = new Set<string>();
    for (const r of await port.neighbors(
      scope,
      opts?.scopeRel,
      opts?.scopeDir,
    )) {
      // The anchor's own author is metadata about the anchor, not knowledge in its context. Without
      // this, every anchored injection would carry whoever filed the anchor (since the gate records
      // authorship on every entity). Authorship pointing AT the anchor is the persona hop and stays.
      if (r.type === "authored_by" && r.from === scope) continue;
      if (opts?.scopeRel === undefined && membership.has(r.type)) continue;
      const other: string = r.from === scope ? r.to : r.from;
      if (other !== scope) hopIds.add(other);
    }
    if (query) {
      // Full query results, scope-linked ones first (stable partition) — the
      // working context leads, org-wide matches still included.
      //
      // BOUNDED, and status-filtered. This call used to pass no limit at all, and at 10M entities
      // it killed the process: the adapter built ten million row objects and the heap ran out
      // (docs/SCALE.md). See candidateQuery for why the bound is a multiple of the caller's limit.
      const hits = await port.search({ text: query, ...candidateQuery(opts) });
      candidates = [
        ...hits.filter((e) => hopIds.has(e.id)),
        ...hits.filter((e) => !hopIds.has(e.id)),
      ];
    } else {
      // No query: a briefing of the working context — the hop set only.
      candidates = [];
      for (const id of hopIds) {
        const e = await port.getEntity(id);
        // ns is not a point-read filter (getEntity is id-based), so enforce it here to match search().
        if (e && normalizeNs(e.ns) === ns) candidates.push(e);
      }
    }
  } else {
    // See candidateQuery. Asking the store for exactly `limit` meant the caller got `limit` minus
    // however many were draft, stale or deprecated: measured at every corpus size from 10k to 10M, a
    // request for 50 returned 29 while 589,285 injectable records sat unreturned (docs/SCALE.md).
    candidates = await port.search({ text: query, ...candidateQuery(opts) });
  }
  const items: InjectItem[] = [];
  for (const entity of candidates) {
    const status = effectiveStatus(entity, ontology, now);
    const pass =
      status === "verified" || (opts?.includeDraft && status === "draft");
    if (!pass) continue;
    items.push({ entity, effectiveStatus: status, citation: citation(entity) });
  }
  // A briefing (anchor, no query) had NO defined order: candidates came out in whatever order the
  // backend returned relations in, which is creation order on sqlite and something else on kuzu and
  // qdrant. That made `limit` a "first recorded N" cut rather than a relevance one, and made the same
  // question answer differently per backend — backend behaviour leaking into core (invariant 2).
  //
  // The query paths are deliberately left alone: their order is search relevance, which is the
  // stronger signal and is theirs to own.
  if (scope && !query) {
    items.sort(
      (a, b) =>
        // Verified before draft (only differ when includeDraft is on).
        Number(b.effectiveStatus === "verified") -
          Number(a.effectiveStatus === "verified") ||
        // Most recently confirmed first — the freshest knowledge about this work leads.
        b.entity.last_confirmed.localeCompare(a.entity.last_confirmed) ||
        // ULID tiebreak. This is the piece that makes every backend agree, so it is not optional.
        a.entity.id.localeCompare(b.entity.id),
    );
  }
  // BOTH paths cap here now, after filtering — that is the fix. `search` is asked for a superset and
  // core cuts to what the caller wanted once only injectable records remain, so `limit` finally means
  // "up to N records you can use" rather than "N candidates, then however many survive".
  const limited =
    opts?.limit === undefined ? items : items.slice(0, opts.limit);
  // How many the caller's limit dropped, out of what was retrieved. On the unscoped path this counts
  // within the over-fetched window rather than the whole corpus: `search` is a top-k, so a number
  // for "everything that matched" is not knowable without materializing it, which is the thing that
  // crashed. Under-reporting a truncation the reader can see is better than a guess they cannot.
  return { items: limited, omitted: items.length - limited.length };
}
