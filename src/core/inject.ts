// inject — context injection (KNOWLEDGE-POLICY soft rule 5: inject strictly).
// search → compute effectiveStatus → by default only verified passes (stale/draft/deprecated excluded).
// The citation format is the smallest unit of the audit trail — pinned by tests.

import { readEntities, type StoragePort } from "../ports/storage.js";
import type { Embedder } from "./embedding.js";
import { effectiveStatus, versionAsOf } from "./lifecycle.js";
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
  asOf?: string;
}) => ({
  ns: opts?.ns,
  // An as-of read must NOT push status down. The stored status is today's; the question is what the
  // status was THEN, and a record retired since is exactly the one such a question is asked about.
  // Pushing `verified` down would filter it out before the rewind could restore it — the same
  // cap-before-filter mistake this function exists to fix, one clock further back.
  //
  // ponytail: that leaves the 3x window as the only bound on an as-of read, so over a corpus that is
  // mostly deprecated it can return a short page. Widen the multiplier when a real corpus shows it,
  // not on the strength of this comment.
  ...(opts?.asOf
    ? {}
    : { status: opts?.includeDraft ? ["verified", "draft"] : "verified" }),
  limit: opts?.limit === undefined ? undefined : opts.limit * STALE_HEADROOM,
});

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009) — the whole hybrid retriever.
 *
 * RANK-based, and that is the point: BM25 and cosine are not commensurable, and absolute cosine is
 * not comparable across embedding models either (docs/RESEARCH.md, measured 2026-08-03). Any weighted
 * sum of the two scores would be arithmetic on incompatible units, tuned to whichever model happened
 * to be configured. Positions have no units.
 *
 * 60 is the published constant, not a tuned one. Its effect is to flatten the top of each list so one
 * list's #1 cannot dominate the other's #1–#5 outright, which is what makes agreement between the two
 * halves the strongest signal.
 *
 * `weight` is NOT part of published RRF and exists for one measured reason (v5.6). SPEC search clause
 * 8 made a long query a disjunction, which turned the keyword half from "returns nothing" into
 * "returns loosely-related records confidently ranked" — and equal-weight fusion then let a keyword
 * rank-1 outrank a vector rank-1 the keyword list had never seen. Measured over eval/gold-set.json,
 * that cost the configured-embedder path **12 points of accuracy@1** (65.2% -> 53.0%) while the
 * keyword-only path was gaining 43. Weights are still applied to RANKS, so the objection above stands:
 * no arithmetic on incompatible scores, only on positions.
 *
 * The FIRST list wins identity ties, so a record found by both keeps the FTS row object — the vector
 * copy carries an `embedding` field and injection results never have.
 */
const RRF_K = 60;
/**
 * How much a keyword rank counts against a vector rank, when both halves answered.
 *
 * Swept over eval/gold-set.json rather than chosen: 1.0 / 0.5 / 0.3 / 0.2 / 0.1 / 0.05 scored
 * accuracy@1 53.0 / 57.6 / 59.1 / 65.2 / 65.2 / 65.2 % and recall@10 84.2 / 85.7 / 87.2 / 88.0 /
 * 88.4 / 88.0 %. The top is a plateau, not a point — 0.05 through 0.2 are indistinguishable on
 * accuracy@1 — which is the only reason a tuned constant is defensible here. At 0.1 every metric is at
 * or above where v5.5 left it (recall 87.2 -> 88.4%, nDCG 74.3 -> 76.1%, accuracy@1 65.2% unchanged),
 * so clause 8's gain on the keyword-only path costs the hybrid path nothing.
 *
 * ponytail: one corpus, one language, one embedding model. It is a floor for the weaker half, not a
 * tuned optimum — re-sweep before trusting it on a corpus that looks different, and if two corpora
 * disagree the answer is a per-deployment setting, not a better number here.
 */
const KEYWORD_WEIGHT = 0.1;
function fuse(lists: Array<{ rows: Entity[]; weight: number }>): Entity[] {
  const score = new Map<string, number>();
  const byId = new Map<string, Entity>();
  for (const { rows, weight } of lists) {
    rows.forEach((e, i) => {
      score.set(e.id, (score.get(e.id) ?? 0) + weight / (RRF_K + i + 1));
      if (!byId.has(e.id)) byId.set(e.id, e);
    });
  }
  return [...byId.values()].sort(
    (a, b) =>
      (score.get(b.id) as number) - (score.get(a.id) as number) ||
      // ULID tiebreak, same reason as the briefing sort: without it two records at the same fused
      // score come out in Map insertion order, which differs per backend.
      a.id.localeCompare(b.id),
  );
}

/**
 * The vector half. Empty array whenever it cannot contribute — no embedder, no `similar` on this
 * backend, or the embedder returned null (unconfigured or unreachable). An empty list means the
 * caller returns the FTS list untouched, so an unconfigured provider retrieves exactly what it did
 * before this existed.
 *
 * A dimension mismatch is deliberately NOT caught: `similar` throws with the repair command in the
 * message, and swallowing it here would leave the vector half silently dead after a model change —
 * the "looks configured, retrieves noise" failure that docs/RESEARCH.md measured.
 */
async function vectorHits(
  port: StoragePort,
  query: string,
  ns: string | null,
  opts?: { embedder?: Embedder; limit?: number },
): Promise<Entity[]> {
  if (!opts?.embedder || !port.similar) return [];
  const vector = await opts.embedder(query);
  if (!vector) return [];
  // `similar` takes no ns filter, so the tenant check happens here. Without it the vector half is a
  // cross-tenant leak the keyword half does not have.
  const hits = await port.similar(
    vector,
    (opts.limit ?? BRIEFING_LIMIT) * STALE_HEADROOM,
  );
  return hits
    .filter((e) => normalizeNs(e.ns) === ns)
    .map((e) => ({ ...e, embedding: undefined }));
}

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
 * @param embedder turns the query into a vector so retrieval is hybrid rather than keyword-only
 *   (SPEC "Hybrid retrieval"). Omitted, unconfigured or unreachable → the FTS list, unchanged. Only
 *   the query paths use it: a briefing has no query text to embed.
 * @param asOf answer as of a past instant: "what would this query have injected then". Replaces the
 *   read clock for freshness AND rewinds every candidate to the version current at that time, so a
 *   record retired since still reads as what it was. See SPEC "As-of injection" for the stated
 *   ceiling — candidate selection is still today's index, so this narrows the past rather than
 *   re-searching it.
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
    asOf?: string;
    embedder?: Embedder;
  },
): Promise<{ items: InjectItem[]; omitted: number }> {
  const scope = opts?.scope;
  // Every freshness and status decision below is made at this instant. `now` stays the parameter so
  // the clock is still injected (SPEC "Time injection"); `asOf` overrides it for one read.
  const readAt = opts?.asOf ?? now;
  const ns = normalizeNs(opts?.ns);
  // Both query paths retrieve the same way — one keyword list, one vector list, fused. Shared so the
  // anchored and unscoped paths cannot drift into two different retrievers.
  const retrieve = async (): Promise<Entity[]> => {
    const fts = await port.search({ text: query, ...candidateQuery(opts) });
    const vec = await vectorHits(port, query, ns, opts);
    // Returning `fts` itself (not a fused list of one) is what makes an unconfigured embedder
    // byte-identical to v5.2: fusion would re-sort ties by id, which is a change nobody asked for.
    return vec.length === 0
      ? fts
      : fuse([
          { rows: fts, weight: KEYWORD_WEIGHT },
          { rows: vec, weight: 1 },
        ]);
  };
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
      //
      // The hop partition stays the OUTER order: fusion decides relevance within each half, and the
      // working context still leads. Anchoring is not a relevance signal, it is a priority one.
      const hits = await retrieve();
      candidates = [
        ...hits.filter((e) => hopIds.has(e.id)),
        ...hits.filter((e) => !hopIds.has(e.id)),
      ];
    } else {
      // No query: a briefing of the working context — the hop set only.
      //
      // ONE batch read, not one per hop id. This loop was the most-run N+1 in the product: every
      // collaboration screen is a briefing, and against the live OpenSearch demo a single one at
      // limit 6 cost 55 round trips (v5.5). Ordering does not matter here — the sort below owns it.
      candidates = (await readEntities(port, hopIds)).filter(
        // ns is not a point-read filter (ids are globally unique), so enforce it here to match search().
        (e) => normalizeNs(e.ns) === ns,
      );
    }
  } else {
    // See candidateQuery. Asking the store for exactly `limit` meant the caller got `limit` minus
    // however many were draft, stale or deprecated: measured at every corpus size from 10k to 10M, a
    // request for 50 returned 29 while 589,285 injectable records sat unreturned (docs/SCALE.md).
    candidates = await retrieve();
  }
  const items: InjectItem[] = [];
  for (const found of candidates) {
    // Under as-of, rewind to the version that was current then before judging it. A record with no
    // version at or before that instant did not exist yet, so it is not knowledge the question can
    // have been answered with.
    const entity = opts?.asOf
      ? await versionAsOf(port, found.id, opts.asOf)
      : found;
    if (!entity) continue;
    const status = effectiveStatus(entity, ontology, readAt);
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
