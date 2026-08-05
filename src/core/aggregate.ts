// aggregate — the global overview of a corpus (v5.7). The third question shape graph retrieval wins
// on (docs/RESEARCH.md §5), after multi-hop and temporal.
//
// "What does this organisation actually know?" is unanswerable by retrieval, at any limit: every
// retrieval path returns a top-k of a query, and the question is about the shape of the whole. GraphRAG
// answers it by LLM-summarising communities. yoke will not — SPEC's HTTP section refuses synthesis and
// results framed as an answer, and a summary of knowledge is a claim nobody verified.
//
// So this returns STRUCTURE, as data: what types exist and in what state, what the corpus is organised
// around, and who its knowledge came from. An agent reading it learns where to ask next; it is a map,
// not an answer.
//
// Cost is two full enumeration scans and no point reads. That is deliberate and stated rather than
// sampled: an aggregate over a sample is not an aggregate, and a number that is quietly approximate is
// worse than a slow one. See SPEC "Global aggregation" for the measured cost and its ceiling.

import { readEntities, type StoragePort } from "../ports/storage.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

/** Per-type counts, keyed by the status a reader actually cares about — the computed one. */
export type StatusCounts = Record<Status, number>;

export interface Hub {
  /** The whole record, not an id and a title: front adapters already know how to summarize an Entity,
   * and core has no business deciding how a person reads one (no opaque ids in human surfaces). */
  entity: Entity;
  /** Relations touching it, both directions, every type. */
  degree: number;
}

export interface Overview {
  entities: {
    total: number;
    /** type -> counts by effective status. `stale` is computed here, so this is the only place the
     * difference between "stored verified" and "injectable today" is visible in one number. */
    byType: Record<string, StatusCounts>;
  };
  relations: {
    total: number;
    byType: Record<string, number>;
  };
  /** Most-connected records first. What the corpus is organised around. */
  hubs: Hub[];
  /** Who the injectable knowledge came from, most first — the persona candidates. Counted off the
   * `authored_by` edge, not `provenance.actor`: see the note in the relation scan for why that
   * distinction is the difference between authors and reviewers. */
  authors: Array<{ actor: string; verified: number }>;
}

const EMPTY: StatusCounts = {
  draft: 0,
  verified: 0,
  stale: 0,
  deprecated: 0,
};

/**
 * Walk the whole namespace once and describe it.
 *
 * @param now the clock, injected as everywhere else in core — `stale` is computed from it, so an
 *   overview taken at two instants over an unchanged corpus legitimately differs.
 * @param opts.top how many hubs and authors to return (default 10). Not a bound on the scan: the
 *   counts are always over everything, and only the two ranked lists are cut.
 */
export async function overview(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null; top?: number },
): Promise<Overview> {
  const ns = normalizeNs(opts?.ns);
  const top = opts?.top ?? 10;
  const byType: Record<string, StatusCounts> = {};
  const authors = new Map<string, number>();
  /** Ids that exist in this namespace, so a dangling relation end does not become a hub. */
  const present = new Set<string>();
  /** Ids whose knowledge is injectable today. Authorship is credited off this set, not off every row.
   *
   * Both of these are id SETS rather than the records themselves, which is the whole memory budget of
   * this function. The first draft kept an `entities` map so the hub list could carry full records, and
   * at 1M entities / 3M relations that cost **511 MB of RSS** — a read whose memory is the size of the
   * corpus, which is the class of defect docs/SCALE.md holds five of. The hubs are re-read by id at the
   * end instead, in one batch call (v5.5), because only `top` of them are ever returned. */
  const injectable = new Set<string>();
  /** Relation types that are structurally metadata rather than connection between knowledge:
   * `authored_by` (every record has exactly one, so it adds a constant) and anything the ontology
   * marks `membership` (a roster). Excluded from DEGREE only — `relations.byType` still counts them,
   * because that is a census of the store and this is a question about what knowledge clusters. */
  const notConnection = new Set([
    "authored_by",
    ...ontology
      .filter((t) => t.kind === "relation" && t.membership)
      .map((t) => t.name),
  ]);

  // Enumeration is a cursor walk the caller drives (SPEC clause 5), so it is paged rather than asked
  // for in one unbounded read — the defect docs/SCALE.md recorded five variants of.
  let after: string | undefined;
  for (;;) {
    const page = await port.listEntities({ ns, after, limit: 500 });
    for (const e of page.items) {
      present.add(e.id);
      const status = effectiveStatus(e, ontology, now);
      byType[e.type] ??= { ...EMPTY };
      byType[e.type][status]++;
      if (status === "verified") injectable.add(e.id);
    }
    if (page.next === null) break;
    after = page.next;
  }

  const relByType: Record<string, number> = {};
  const degree = new Map<string, number>();
  let relTotal = 0;
  after = undefined;
  for (;;) {
    const page = await port.listRelations({ ns, after, limit: 500 });
    for (const r of page.items) {
      relTotal++;
      relByType[r.type] = (relByType[r.type] ?? 0) + 1;
      // Authorship comes off the `authored_by` EDGE, never off `provenance.actor`.
      //
      // This is not a preference. `verify` replaces provenance (lifecycle.ts `transition`), so on a
      // verified record `provenance.actor` is whoever promoted it — an authors list built from that
      // field ranks reviewers and calls them authors, silently, and every record in a reviewed corpus
      // credits one person. The gate mirrors the real author into an edge at commit time and promoting
      // does not pass through the gate, so the edge is the durable claim. It is also exactly what
      // `personaQuery` anchors on, so an overview naming persona candidates and a persona built from
      // one of them cannot disagree.
      if (r.type === "authored_by" && injectable.has(r.from))
        authors.set(r.to, (authors.get(r.to) ?? 0) + 1);
      if (notConnection.has(r.type)) continue;
      // Degree counts the edge once per end. A self-loop therefore counts twice, which is the honest
      // reading of "edges touching this node" and is also what the graph explorer draws.
      for (const end of [r.from, r.to])
        if (present.has(end)) degree.set(end, (degree.get(end) ?? 0) + 1);
    }
    if (page.next === null) break;
    after = page.next;
  }

  const ranked = [...degree.entries()]
    // Degree descending, then id — the same tiebreak every ordered read in this codebase uses, so two
    // backends describing one corpus produce one answer (invariant 2).
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top);
  // One batch read for the handful of records that are actually returned, rather than having held a
  // million. `readEntities` falls back to a point-read loop on a backend without `getEntities`, which
  // for `top` ids is fine — see SPEC "Batch point reads".
  const byId = new Map(
    (
      await readEntities(
        port,
        ranked.map(([id]) => id),
      )
    ).map((e) => [e.id, e]),
  );
  const hubs = ranked
    .map(([id, d]) => ({ entity: byId.get(id), degree: d }))
    // A hub whose record vanished between the two scans is dropped rather than returned as a hole:
    // this is a live database, not a snapshot, and `present` was read a moment earlier.
    .filter((h): h is Hub => h.entity !== undefined);

  return {
    entities: { total: present.size, byType },
    relations: { total: relTotal, byType: relByType },
    hubs,
    authors: [...authors.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([actor, verified]) => ({ actor, verified })),
  };
}
