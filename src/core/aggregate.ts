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
  /** Present only when `opts.since` is given: what was captured in that window, which is the one number
   * the adoption playbook's rituals are supposed to move (ADOPTION.md §6 "capture density"). Absent
   * rather than zeroed without a window, so a reader cannot mistake "not asked" for "nothing captured". */
  captured?: {
    since: string;
    /** Records whose authorship edge is dated at or after `since`, by type — every status, because a
     * draft nobody has promoted yet is still capture that happened. */
    byType: Record<string, number>;
    /** Same window, by author. This is the per-person weekly number the review sweep is measured by. */
    byAuthor: Array<{ actor: string; records: number }>;
    total: number;
  };
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
 * @param opts.since adds the `captured` window. Dated off the `authored_by` edge's own
 *   `provenance.occurred_at`, which is the capture act's instant and the only one that survives
 *   promotion — an entity's head provenance is the promoter's. Consequence worth knowing before
 *   quoting a weekly number: a connector stamps `occurred_at` from the SOURCE, so importing a
 *   three-year archive credits those records to the weeks they happened in, not to the week they
 *   arrived. That is the right answer for "when was this decided" and the wrong one for "how much did
 *   we import"; the audit trail answers the second.
 */
export async function overview(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null; top?: number; since?: string },
): Promise<Overview> {
  const ns = normalizeNs(opts?.ns);
  const top = opts?.top ?? 10;
  const since = opts?.since;
  const byType: Record<string, StatusCounts> = {};
  const authors = new Map<string, number>();
  /** id -> type, for every entity in the namespace. Only built when a window was asked for: the
   * captured counts are per TYPE and the authorship edge names only ids, so without this the window
   * could report who captured but not what. One string per entity against `present`'s one string, and
   * only on a path the caller opted into. */
  const typeById = since ? new Map<string, string>() : null;
  const capturedByType: Record<string, number> = {};
  const capturedByAuthor = new Map<string, number>();
  /** Ids that exist in this namespace, so a dangling relation end does not become a hub. */
  const present = new Set<string>();
  /** Ids whose knowledge is injectable today. Authorship is credited off this set, not off every row.
   *
   * Both of these are id SETS rather than the records themselves, which is the whole memory budget of
   * this function. Keeping an `entities` map so the hub list could carry full records costs **511 MB of
   * RSS** at 1M entities / 3M relations — a read whose memory is the size of the corpus, the class of
   * defect docs/SCALE.md holds five of. The hubs are re-read by id at the end instead, in one batch
   * call, because only `top` of them are ever returned. */
  const injectable = new Set<string>();
  /** Entity types the ontology marks structural (`person`, `collaboration`, …): a person or a piece of
   * work is what knowledge attaches to, never injectable knowledge itself. `inject` and `personaQuery`
   * both withhold them by TYPE; the authors ranking credits authorship off `injectable`, so keeping
   * these out of that set is what makes "verified knowledge by author" agree with the injection
   * surfaces instead of crediting a verified person + collaboration as two knowledge records. */
  const structuralTypes = new Set(
    ontology
      .filter((t) => t.kind === "entity" && t.structural)
      .map((t) => t.name),
  );
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
      typeById?.set(e.id, e.type);
      const status = effectiveStatus(e, ontology, now);
      byType[e.type] ??= { ...EMPTY };
      byType[e.type][status]++;
      if (status === "verified" && !structuralTypes.has(e.type))
        injectable.add(e.id);
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
      // The capture window counts the same edge but over EVERY status, not just `injectable`: a draft
      // waiting in the review queue is capture that happened, and measuring density off verified
      // records only would credit the reviewer's backlog to the author's week. Structural types stay
      // out for the same reason they stay out of the authors ranking — seeding 30 `person` rows is
      // scaffolding, and counting it as capture reports a roster import as a productive week.
      if (
        since &&
        r.type === "authored_by" &&
        r.provenance.occurred_at >= since
      ) {
        const type = typeById?.get(r.from);
        if (type && !structuralTypes.has(type)) {
          capturedByType[type] = (capturedByType[type] ?? 0) + 1;
          capturedByAuthor.set(r.to, (capturedByAuthor.get(r.to) ?? 0) + 1);
        }
      }
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
    ...(since
      ? {
          captured: {
            since,
            byType: capturedByType,
            // Not cut to `top`: a density report exists to find who has stopped capturing, and a
            // ranked list truncated at ten hides exactly them.
            byAuthor: [...capturedByAuthor.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([actor, records]) => ({ actor, records })),
            total: Object.values(capturedByType).reduce((a, n) => a + n, 0),
          },
        }
      : {}),
  };
}
