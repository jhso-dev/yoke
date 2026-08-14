// inject — context injection (KNOWLEDGE-POLICY soft rule 5: inject strictly).
// search → compute effectiveStatus → by default only verified passes (stale/draft/deprecated excluded).
// The citation format is the smallest unit of the audit trail — pinned by tests.

import { readEntities, type StoragePort } from "../ports/storage.js";
import type { Embedder } from "./embedding.js";
import { atOrBefore, effectiveStatus, versionAsOf } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

export interface InjectItem {
  entity: Entity;
  effectiveStatus: Status;
  citation: string;
  /**
   * Ids of verified records this one is recorded as contradicting (`conflicts_with`), if any.
   *
   * MARKED, not withheld, because that is what the policy says: "contradictions are surfaced, never
   * auto-resolved … deciding the winner is not the database's job" (README mechanism 4). Dropping either
   * side would be the database deciding; dropping both would delete the disagreement, which is itself
   * knowledge. So both travel and both say so.
   *
   * The store already knew. `yoke conflicts` printed the pair; injection — the product's core value —
   * never mentioned it, so six queries on the demo corpus handed an agent both sides of a live
   * disagreement as two equal facts: two deploy-freeze windows, three different Critical-patch SLAs, two
   * refund limits, two mutually exclusive definitions of MAU. Absent on a record with nothing to
   * declare, so a reader can tell "not disputed" from "we did not look".
   */
  conflictsWith?: string[];
  /**
   * Who actually wrote this, off the `authored_by` edge — absent when the record has no such edge.
   *
   * Exposed as well as folded into `citation` because a front tier has to RESOLVE it: the id is what
   * makes a citation an audit pointer, and the name is what makes a line readable, so the two coexist
   * (the web has always sent both). Without this a surface wanting the name would have to parse it back
   * out of the citation string.
   */
  author?: string;
}

/** What a multi-hop anchor walk actually did (SPEC "Multi-hop"). Numbers only — front adapters turn
 * them into words, the same division of labour `omitted` already has. */
export interface WalkStats {
  /** Deepest distance actually reached. Below the requested depth means the graph ran out, or the
   * budget did — `truncated` is which. */
  depth: number;
  /** Size of the hop set the walk produced, before status filtering and before `limit`. */
  nodes: number;
  /** True when WALK_BUDGET stopped the expansion, so the farthest band is incomplete. */
  truncated: boolean;
}

/**
 * Why an empty answer is empty (counts only — front adapters turn them into words, the same division
 * of labour `omitted` and `WalkStats` already have).
 *
 * An empty injection is the one result a reader cannot interpret: knowledge that is absent, knowledge
 * that is waiting for review, and knowledge that was retired all read as "no results", and the reader
 * has no way to tell which. The CLI had half of this — a second search for drafts, human output only,
 * so `--json` and the MCP tool (the paths an AGENT reads) got the bare "no results" while the terminal
 * got the explanation. Three surfaces, three phrasings, one of them right.
 *
 * `structural` is the reason that misdirects worst if left unsaid: a verified `person` matching the
 * query is withheld by type, so a reader told "draft withheld" verifies it and the answer gets no
 * better — the record was never injectable knowledge (see the structural note below).
 */
export interface WithheldStats {
  /** Matched, but still awaiting review. Reachable with `includeDraft`, or by verifying. */
  draft: number;
  /** Matched and verified, but past its type's TTL. Reachable by re-confirming. */
  stale: number;
  /** Matched, but retired. Not reachable — the retirement is the answer. */
  deprecated: number;
  /** Matched, but names something knowledge is attached TO. Never injectable as knowledge. */
  structural: number;
  /**
   * Matched and verified, but something recorded as superseding it exists.
   *
   * Withheld rather than marked, unlike a conflict, because the two states mean different things. A
   * conflict is an open disagreement nobody has settled; a supersession is settled — someone recorded
   * that this was replaced. Serving it is serving a decision that was reversed.
   *
   * `supersedes` had no lifecycle meaning at all: the only code in the product that understood it was
   * `checkPersonaSources`, so an exported persona listed both halves of a reversal as live guiding
   * principles with identical timestamps, and the product's OWN checker then labelled that export
   * "superseded" and exited 1 while offering a re-export that reproduces it byte for byte.
   */
  superseded: number;
}

export interface InjectResult {
  items: InjectItem[];
  omitted: number;
  /** Present only when the walk went deeper than one hop. */
  walk?: WalkStats;
  /** Present when something matched that could not be injected — including alongside a non-empty
   * `items`, where a reader handed a full page has no other way to learn that the record answering
   * their question was held back. Absent means everything that matched was handed over. */
  withheld?: WithheldStats;
}

/**
 * How many nodes a multi-hop walk expands the edges of, breadth-first.
 *
 * A bound rather than a guess about graph shape: `neighbors` is one call per expanded node, so an
 * unbounded walk over a hub is the same class of defect docs/SCALE.md recorded five of — a read whose
 * cost is set by the corpus rather than by the caller. Breadth-first means what a cut removes is
 * always the farthest band, which is the band that mattered least.
 *
 * Never silent: the cut sets `walk.truncated`.
 *
 * ceiling: 128 is one round trip per node on a remote backend, sequentially. Raise it, or add bounded
 * concurrency (the UI's graph route already needed `mapLimit` at FANOUT 16), when a real multi-hop
 * workload is measured against something that is not sqlite.
 */
export const WALK_BUDGET = 128;

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
 * ceiling: fixed multiplier, no adaptive re-query. Add the second round trip when a real corpus is
 * measured returning short pages, not on the strength of this comment.
 */
const STALE_HEADROOM = 3;

/**
 * The two relations that change what a record MEANS to a reader, read in one hop.
 *
 * Both were invisible to injection: `grep conflicts_with src/core/inject.ts` found nothing, and
 * `supersedes` was understood by exactly one function in the product (`checkPersonaSources`). The
 * consequences are recorded on `InjectItem.conflictsWith` and `WithheldStats.superseded`.
 *
 * One `neighbors(id)` per record, unfiltered, then split in memory — two typed calls would double the
 * round trips for the same answer. Namespace-filtered here for the reason `identitySet` and
 * `downstreamOf` are: `neighbors` takes no `ns`, so an edge filed by one tenant would otherwise mark or
 * withhold another tenant's record.
 *
 * Direction matters and only one way round is right. `A supersedes B` means A replaced B, so B carries
 * the INCOMING edge and B is the record that is no longer current. Reading it the other way would
 * withhold every replacement and serve everything it replaced.
 *
 * `asOf` rewinds the edges too. Without it an `--as-of 2020` read was answered with 2026's relation
 * graph: a supersession recorded years after the instant asked about withheld a record that was current
 * then, which is the same mistake `countWithheld` rewinds versions to avoid, one table over. Filtered on
 * `provenance.occurred_at` — when the edge SAYS the link happened — through `atOrBefore`, which is
 * `versionAsOf`'s comparison and has to be: comparing the two clocks differently makes one as-of read
 * answer itself two ways.
 *
 * ceiling: an edge's `status` is not consulted, and cannot be. Every relation is committed `draft` and
 * no path promotes one (`lifecycle.transition` refuses relation ids), so requiring `verified` here would
 * disable supersession entirely rather than make it stricter. That leaves withholding — the one thing
 * here that REMOVES verified knowledge from an answer — trusting an edge the governance layer cannot
 * reach. The gate is the only check it passed. Fix the asymmetry by making edges promotable (a
 * KNOWLEDGE-POLICY decision: should an unverified edge route injection at all?), not by tightening this
 * line.
 *
 * ceiling: one relation read per record handed over — the cap, not the retrieval window, so a page of
 * ten costs ten and a fifty-record briefing costs fifty. Not benchmarked: the sqlite read is a single
 * indexed lookup, but fifty sequential round trips is the shape docs/SCALE.md profiled as slow on a
 * remote backend. The way out is a batch `neighborsOf(ids)` on the port; add that before raising any
 * limit that multiplies this.
 */
async function meaningEdges(
  port: StoragePort,
  id: string,
  ns: string | null,
  asOf?: string,
): Promise<{
  superseded: boolean;
  conflictsWith: string[];
  author?: string;
}> {
  const edges = (await port.neighbors(id)).filter(
    (r) =>
      normalizeNs(r.ns) === ns &&
      (asOf === undefined || atOrBefore(r.provenance.occurred_at, asOf)),
  );
  return {
    // The real author, for the citation. Free here: this read already has every edge, and asking for it
    // separately would be a second round trip for a field the first one returned.
    author: edges.find((r) => r.type === "authored_by" && r.from === id)?.to,
    superseded: edges.some((r) => r.type === "supersedes" && r.to === id),
    // Symmetric, so the pair is one claim recorded from whichever end — both directions count.
    conflictsWith: [
      ...new Set(
        edges
          .filter((r) => r.type === "conflicts_with")
          .map((r) => (r.from === id ? r.to : r.from))
          .filter((other) => other !== id),
      ),
    ].sort(),
  };
}
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
  // ceiling: that leaves the 3x window as the only bound on an as-of read, so over a corpus that is
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
 * ceiling: one corpus, one language, one embedding model. It is a floor for the weaker half, not a
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
 * caller returns the FTS list untouched, so an unconfigured provider gets keyword retrieval and
 * nothing degrades.
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

/**
 * `[{type}:{id}@v{version}] {actor}, {occurred_at}` — the audit citation format.
 *
 * With `author` (the `authored_by` edge's target) it becomes
 * `[…] {author} (confirmed by {promoter}), {occurred_at}` — and ONLY when the two differ, so the
 * single-user local path renders exactly as before.
 *
 * The plain form names whoever wrote the version being pointed at, which for a verified record is
 * whoever PROMOTED it: `verify` appends a version whose provenance is the promotion. That is correct
 * about the version and wrong about the knowledge. Measured: a decision authored under Alex's person id
 * and verified by the reviewer was served inside Alex's persona citing `yoke:system`, so an agent
 * quoting yoke names the wrong person. `docs/SPEC.md:682` states the rule this broke —
 * "authorship comes off the `authored_by` edge, never `provenance.actor` … an authors list built from
 * it ranks reviewers, calls them authors". `overview` obeys it and says so in its own output; the
 * citation did not.
 *
 * Both, rather than swapping one for the other. The promoter is not noise — it is who vouched for this,
 * which is the other half of what makes a citation auditable — and dropping it to fix attribution would
 * trade one missing fact for another. It is invisible on a single-user database because there the two
 * ARE the same actor, which is exactly why this went unnoticed.
 */
export function citation(e: Entity, author?: string): string {
  const promoter = e.provenance.actor;
  const who =
    author && author !== promoter
      ? `${author} (confirmed by ${promoter})`
      : promoter;
  return `${pointer(e)} ${who}, ${e.provenance.occurred_at}`;
}

/**
 * The pointer half of a citation: which record, which version, and nothing about who.
 *
 * Split out because one reader needs the pointer without the actor. `provenance.actor` on a promoted
 * row is whoever PROMOTED it (verify appends a version with `origin: 'lifecycle'`), which is the right
 * thing for an audit pointer and the wrong thing inside a document that claims to be one person's
 * judgment — see `renderPersonaSkill`. One format string, two readings of it.
 */
export function pointer(e: Entity): string {
  return `[${e.type}:${e.id}@v${e.version}]`;
}

/**
 * The entity ids that whatever a caller pasted back might mean, best guess first — `01K…`,
 * `fact:01K…`, `fact:01K…@v2`, or the whole `[fact:01K…@v2] actor, when`.
 *
 * CANDIDATES rather than one answer, because `type:id` and a readable id are the same shape: this
 * repo's own corpus generator mints `person:platform-manager`, so stripping before the colon is
 * sometimes right and sometimes destroys the id. Guessing is avoidable — the caller can simply try
 * each against the store and keep the one that resolves, which is a fact rather than a heuristic.
 *
 * It lives beside `citation` because it is that function's inverse and the two must not drift.
 *
 * Why it is needed at all: every surface shows a record as its CITATION and never as a bare id, so an
 * agent told to cite "ids that inject returned to you" cites the thing it was shown. Measured on three
 * agents handed the tool and a realistic task — all three cited their basis unprompted, two of the
 * three in a form that resolves to nothing.
 */
export function entityIdCandidates(raw: string): string[] {
  let s = raw.trim();
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    s = close === -1 ? s.slice(1) : s.slice(1, close);
  }
  // A pasted citation carries the actor and timestamp after the bracket; take the first token.
  s = (s.split(/[\s,]/)[0] ?? "").replace(/@v\d+$/, "");
  if (!s) return [];
  const colon = s.indexOf(":");
  // Ordered: the string as given first, since an id that already resolves needs no surgery.
  return colon > 0 && colon < s.length - 1 ? [s, s.slice(colon + 1)] : [s];
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
    /** Relation hops the anchor walk takes (SPEC "Multi-hop"). Default 1 — the v4.0 behaviour, byte
     * for byte. Only meaningful with `scope`. */
    depth?: number;
    asOf?: string;
    embedder?: Embedder;
  },
): Promise<InjectResult> {
  const scope = opts?.scope;
  /** Set only when the walk went deeper than one hop — see SPEC "Multi-hop". */
  let walk: WalkStats | undefined;
  /** id -> shortest hop distance from the anchor. Empty on the unscoped path, which has no anchor to
   * measure from; the briefing sort below reads it, so it lives out here rather than in the branch. */
  const distance = new Map<string, number>();
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
  // Relation types the ontology marks as membership. Walking them would hand the roster to an agent
  // as knowledge; who is involved in the work belongs on a screen, not in a briefing. Skipped only
  // when the caller did not ask for that type by name — `scopeRel: 'works_on'` is someone
  // deliberately asking for members, and this must not silently return nothing.
  const membership = new Set(
    ontology
      .filter((t) => t.kind === "relation" && t.membership)
      .map((t) => t.name),
  );
  // A caller who named a membership relation asked for the roster ON PURPOSE. That is the one request
  // structural records are the answer to, so it is the one request they survive.
  const askedForRoster =
    opts?.scopeRel !== undefined && membership.has(opts.scopeRel);
  let candidates: Entity[];
  if (scope) {
    // The anchor walk: `depth` relation hops out, breadth-first, each id held at its SHORTEST
    // distance (SPEC "Multi-hop"). At depth 1 this is the single `neighbors` call it always was.
    const depth = Math.max(1, opts?.depth ?? 1);
    let frontier = [scope];
    let expanded = 0;
    let truncated = false;
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      // Sorted so a budget-truncated walk removes the same nodes every run: `neighbors` promises no
      // ordering, so without this the cut would depend on the backend (invariant 2).
      for (const node of [...frontier].sort()) {
        if (expanded >= WALK_BUDGET) {
          truncated = true;
          break;
        }
        expanded++;
        for (const r of await port.neighbors(
          node,
          opts?.scopeRel,
          opts?.scopeDir,
        )) {
          // An author is metadata about the record, not knowledge in its context. v4.0 dropped this
          // for the anchor only; at depth 2 that hands over the author of every neighbour, which is
          // the roster problem `membership` exists to prevent arriving through an unmarked relation
          // type. Authorship pointing AT a node is still the persona hop and stays.
          if (r.type === "authored_by" && r.from === node) continue;
          if (opts?.scopeRel === undefined && membership.has(r.type)) continue;
          const other: string = r.from === node ? r.to : r.from;
          // Never the anchor itself, and never demote a record already reached more cheaply.
          if (other === scope || distance.has(other)) continue;
          distance.set(other, d);
          next.push(other);
        }
      }
      frontier = next;
    }
    const hopIds = new Set(distance.keys());
    // Only reported when it means something: at depth 1 there is no walk to describe.
    if (depth > 1)
      walk = {
        depth: Math.max(0, ...distance.values()),
        nodes: hopIds.size,
        truncated,
      };
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
      // Partitioned by distance ascending, then everything the walk never reached. At depth 1 this is
      // the same two-band split v4.0 made; deeper, a hop-1 record still leads a hop-3 one, and fusion
      // keeps owning the order WITHIN each band. Distance is a priority signal, not a relevance one.
      const band = (e: Entity) => distance.get(e.id) ?? Number.MAX_SAFE_INTEGER;
      candidates = hits
        .map((e, i) => ({ e, i }))
        .sort((a, b) => band(a.e) - band(b.e) || a.i - b.i)
        .map((x) => x.e);
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
  // Entity types the ontology marks as structural: a person, a piece of work — the things knowledge
  // is attached TO, rather than things anyone recorded as true.
  //
  // This is the rule `membership` states for relations, applied where that one cannot reach.
  // `membership` skips the roster EDGE, so a person linked to a collaboration by `relates_to`
  // instead of `works_on` still arrived as a record to brief an agent with; and on the persona path
  // the walk IS `authored_by`, so nothing skipped the collaborations its subject had created — they
  // were handed over as things that person knows, competing for the same limit as real judgments.
  const structural = new Set(
    ontology
      .filter((t) => t.kind === "entity" && t.structural)
      .map((t) => t.name),
  );
  const items: InjectItem[] = [];
  for (const found of candidates) {
    if (!askedForRoster && structural.has(found.type)) continue;
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
  // backend returned relations in, which is creation order on sqlite and whatever the query planner
  // chose elsewhere. That made `limit` a "first recorded N" cut rather than a relevance one, and made the same
  // question answer differently per backend — backend behaviour leaking into core (invariant 2).
  //
  // The query paths are deliberately left alone: their order is search relevance, which is the
  // stronger signal and is theirs to own.
  if (scope && !query) {
    items.sort(
      (a, b) =>
        // Nearest first. A hop-3 record is context; a hop-1 record is the subject. Absent from the map
        // cannot happen on this path (every candidate came out of the walk), so the fallback is only
        // there to keep the comparator total.
        (distance.get(a.entity.id) ?? 0) - (distance.get(b.entity.id) ?? 0) ||
        // Verified before draft (only differ when includeDraft is on).
        Number(b.effectiveStatus === "verified") -
          Number(a.effectiveStatus === "verified") ||
        // Most recently confirmed first — the freshest knowledge about this work leads.
        // By instant, not by collation: on a database holding both pre- and post-canonicalization
        // stamps, `Z` sorts after `.`, so 00:00:00.500Z read as older than 00:00:00Z.
        Date.parse(b.entity.last_confirmed) -
          Date.parse(a.entity.last_confirmed) ||
        // ULID tiebreak. This is the piece that makes every backend agree, so it is not optional.
        a.entity.id.localeCompare(b.entity.id),
    );
  }
  // BOTH paths cap here now, after filtering — that is the fix. `search` is asked for a superset and
  // core cuts to what the caller wanted once only injectable records remain, so `limit` finally means
  // "up to N records you can use" rather than "N candidates, then however many survive".
  const capped = opts?.limit === undefined ? items : items.slice(0, opts.limit);
  // Supersession and contradiction, applied to the page rather than to the window — the cost is one
  // relation read per record actually handed over (see `meaningEdges`). Superseded records drop out and
  // are counted; contradicted ones travel carrying what they contradict.
  //
  // A page can come back short of `limit` because of this. It is not backfilled from further down the
  // ranking: doing so would mean reading relations for the whole window to find replacements, and a
  // short page a reader can see beats a full one assembled by a second pass they cannot.
  //
  // The shortfall is reported by `withheld.superseded`, NOT by `omitted` — those are two different
  // facts and folding them together made both untrue. `omitted` means "your limit cut this many, ask
  // again or raise it", which is what every front end says in words: the MCP tool tells an agent the
  // remainder is "NOT lost … ask a specific question and it searches everything". A superseded record
  // is not reachable that way at any limit, so counting it there turned an accurate instruction into a
  // false one, and a caller who passed no `limit` at all was told their limit had dropped records.
  let supersededCount = 0;
  const limited: InjectItem[] = [];
  for (const item of capped) {
    const { superseded, conflictsWith, author } = await meaningEdges(
      port,
      item.entity.id,
      ns,
      opts?.asOf,
    );
    if (superseded) {
      supersededCount++;
      continue;
    }
    limited.push({
      ...item,
      // Rebuilt now that the author is known. Without it `citation` names the promoter alone, which on a
      // verified record is whoever approved the knowledge rather than whoever wrote it.
      citation: citation(item.entity, author),
      ...(author ? { author } : {}),
      ...(conflictsWith.length > 0 ? { conflictsWith } : {}),
    });
  }
  // Say what was held back, whether or not anything came through. It was once computed only for the
  // empty answer, on the theory that an empty result is the one a reader cannot interpret. A partial
  // answer is worse: measured on the demo corpus, "why didn't we choose Kafka" returns ten unrelated
  // records while the decision that answers it — rationale, rejected alternatives and all — sits one
  // TTL past its window. The reader gets a full page and concludes nothing was ever recorded. An
  // absence a reader can see beats a filter they cannot, and that argument does not stop at zero.
  //
  // The query path has to re-ask because `candidateQuery` pushes `status` DOWN: a withheld draft never
  // reached this function to be counted, and over-fetching INSTEAD of pushing was tried and disproven
  // (see candidateQuery). The anchor path already holds every status (the walk filters none), so it
  // reuses the candidates it has and costs nothing.
  //
  // The diagnostic asks for the same 3x window the primary retrieval uses, minus the status push-down.
  // At the caller's bare limit it cannot see what it is looking for: the whole point is a record ranked
  // BELOW the page that was filtered out of it, and a window the size of the page contains only records
  // that made the page. The bias the push-down exists to correct — verified rows sorting last on tied
  // relevance, because `verify` rewrites the FTS row — is harmless here and mildly helpful: this pass
  // wants the rows injection rejected.
  //
  // ceiling: one extra `search` per query-path injection, bounded by the same O(matches) ranking cost
  // as the primary retrieval (docs/SCALE.md). The way out is a port-level count of matches by status,
  // which no backend exposes today — add that before widening this window again.
  const withheld = await countWithheld(
    port,
    ontology,
    scope
      ? candidates
      : await port.search({
          text: query,
          ns,
          limit:
            opts?.limit === undefined ? undefined : opts.limit * STALE_HEADROOM,
        }),
    readAt,
    askedForRoster,
    limited,
    opts?.asOf,
    supersededCount,
  );
  return {
    items: limited,
    // How many the caller's LIMIT dropped, out of what was retrieved — and only that, which is why it
    // is measured against `capped` rather than against the page finally handed over (see the loop
    // above). On the unscoped path it counts within the over-fetched window rather than the whole
    // corpus: `search` is a top-k, so a number for "everything that matched" is not knowable without
    // materializing it, which is the thing that crashed. Under-reporting a truncation the reader can
    // see is better than a guess they cannot.
    omitted: items.length - capped.length,
    ...(walk ? { walk } : {}),
    ...(withheld ? { withheld } : {}),
  };
}

/**
 * Classify what matched but did not pass, by the reason it did not.
 *
 * One reason per record, structural first: a structural record is withheld by TYPE whatever its
 * status, so counting it as "draft" would name a fix (verify it) that cannot work.
 *
 * Returns undefined when nothing was withheld, which is what lets a caller distinguish "the query
 * matched nothing" from "the query matched only knowledge you cannot have".
 */
async function countWithheld(
  port: StoragePort,
  ontology: TypeDef[],
  candidates: Entity[],
  readAt: string,
  askedForRoster: boolean,
  injected: InjectItem[],
  asOf?: string,
  superseded = 0,
): Promise<WithheldStats | undefined> {
  // What was handed over is not withheld. Only matters now that this runs alongside a non-empty
  // answer: the anchor path passes the very candidates the items were built from, so without this
  // every injected record would also be counted as held back.
  const handed = new Set(injected.map((i) => i.entity.id));
  const structuralTypes = new Set(
    ontology
      .filter((t) => t.kind === "entity" && t.structural)
      .map((t) => t.name),
  );
  const stats: WithheldStats = {
    draft: 0,
    stale: 0,
    deprecated: 0,
    structural: 0,
    // Counted by the caller, which is the only place that knows: supersession is decided on the page it
    // is about to hand over, not on the retrieval window this function classifies.
    superseded,
  };
  for (const found of candidates) {
    if (handed.has(found.id)) continue;
    if (!askedForRoster && structuralTypes.has(found.type)) {
      stats.structural++;
      continue;
    }
    // Classify the version that was current at the instant asked about, the way the returning path
    // already does. Judging today's row made an as-of read blame a retirement that had not happened
    // yet: `--as-of 2020-01-01` on a corpus created in 2026 answered "1 retired", and a record that
    // was a draft then was reported retired because it is retired now.
    const entity = asOf ? await versionAsOf(port, found.id, asOf) : found;
    // No version at or before that instant: the record did not exist yet, so nothing was withheld.
    if (!entity) continue;
    const status = effectiveStatus(entity, ontology, readAt);
    if (status === "draft") stats.draft++;
    else if (status === "stale") stats.stale++;
    else if (status === "deprecated") stats.deprecated++;
  }
  const total =
    stats.draft +
    stats.stale +
    stats.deprecated +
    stats.structural +
    stats.superseded;
  return total > 0 ? stats : undefined;
}
