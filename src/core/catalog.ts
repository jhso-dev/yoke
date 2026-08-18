// catalog — what the organisation runs, read through the gate (v7.3.4).
//
// The portal's front door. Every row carries the record's effective status, its freshness and its owner
// chain, which is the condition WEB-UI.md's amended test 1 admits this screen under: a catalog that cannot
// be read without seeing what is stale and what was never verified is a governance surface, and a catalog
// that hides that is the decay Backstage ships.
//
// It computes nothing it could read. Status comes from `effectiveStatus` (the same function injection
// filters on), the owner from the same `owns` edge the importer files, and the freshness from the type's
// own TTL — so a row cannot claim health this database does not hold. There is no ranking here, which is
// what keeps test 2 (no second ranker) intact.

import type { StoragePort } from "../ports/storage.js";
import { citation } from "./inject.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

/** The entity types a catalog is made of. Declared in ontology/catalog.json, not in the seed. */
export const CATALOG_TYPES = ["service", "api", "datastore"] as const;

export interface CatalogRow {
  id: string;
  type: string;
  name: string;
  /** As `inject` would see it today, so a row and an agent's context cannot disagree. */
  status: Status;
  lifecycle?: string;
  repo?: string;
  /**
   * Everyone accountable, from the `owns` edge. Empty = nobody claims it.
   *
   * A LIST, because a real estate has services two groups both claim, and reporting the first one is the
   * screen reporting health it did not check — the thing WEB-UI.md's amended test 1 forbids. Contested
   * ownership is itself the finding: "who do I ask" with two answers is not an answered question.
   */
  owners: string[];
  /** How many things this depends on, and how many depend on it. */
  dependsOn: number;
  dependents: number;
  /** Doc `resource` records attached to it. 0 is a finding, not a blank. */
  docs: number;
  /**
   * Every knowledge record attached to it, of any type.
   *
   * The scorecard needs it to tell "nothing has rotted" from "nothing is recorded": both leave `stale` at
   * 0, and reporting the first when the second is true is how a scorecard rewards silence.
   */
  attached: number;
  /** The most recent verified `decision` about it, if any — the "why is it like this" link. */
  latestDecision?: { id: string; summary: string; at: string };
  /**
   * Attached records that are stale TODAY, and this row's own staleness is counted in it. The number the
   * screen sorts by: a service whose knowledge has rotted is the one to look at first.
   */
  stale: number;
  /**
   * Distinct `conflicts_with` PAIRS among its attached records.
   *
   * Deduplicated by the unordered pair, because a contradiction between two records that are both attached
   * to this row is seen once from each end — counted naively, one disagreement reads as two.
   */
  conflicts: number;
  /**
   * The row's own source, in the authoritative form.
   *
   * A catalog row IS a record, so WEB-UI.md's "knowledge is never shown without its source" applies to
   * it — and it earns its place here rather than being an exemption: the citation is what distinguishes
   * a service someone typed from one an import filed, which is exactly the question a reader of a
   * suspicious row asks.
   */
  citation: string;
  actor: string;
  occurred_at: string;
  version: number;
}

/**
 * Read the catalog.
 *
 * @param opts.owner only rows this group or person owns.
 * @param opts.staleOnly only rows with something stale attached (including themselves).
 *
 * ceiling: one neighbour walk per catalog row, and a catalog is a screen-sized list of services rather
 * than a corpus — a 500-service org is 500 walks, which is the same shape `overview`'s hub read has. An
 * org with tens of thousands of services wants the counts materialized, not a smarter walk.
 */
export async function catalog(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null; owner?: string; staleOnly?: boolean },
): Promise<CatalogRow[]> {
  const ns = normalizeNs(opts?.ns);
  const rows: CatalogRow[] = [];
  const declared = new Set(
    ontology.filter((t) => t.kind === "entity").map((t) => t.name),
  );
  for (const type of CATALOG_TYPES) {
    // A type the ontology does not declare cannot have rows; asking anyway would be a scan per absent
    // type on every database that never loaded the fragment.
    if (!declared.has(type)) continue;
    let after: string | undefined;
    for (;;) {
      const page = await port.listEntities({ ns, type, after, limit: 500 });
      for (const e of page.items) {
        const row = await describe(port, ontology, e, now, ns);
        if (opts?.owner && !row.owners.includes(opts.owner)) continue;
        if (opts?.staleOnly && row.stale === 0) continue;
        rows.push(row);
      }
      if (page.next === null) break;
      after = page.next;
    }
  }
  // Most rot first, then name — the screen exists to surface decay, so the default order is the finding.
  // A stable tiebreak on id keeps two backends describing one corpus in one order (invariant 2).
  return rows.sort(
    (a, b) =>
      b.stale - a.stale ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

async function describe(
  port: StoragePort,
  ontology: TypeDef[],
  entity: Entity,
  now: string,
  ns: string | null,
): Promise<CatalogRow> {
  const status = effectiveStatus(entity, ontology, now);
  const owners = (await port.neighbors(entity.id, "owns", "in")).map(
    (r) => r.from,
  );
  const dependsOn = await port.neighbors(entity.id, "depends_on", "out");
  const dependents = await port.neighbors(entity.id, "depends_on", "in");
  const incoming = await port.neighbors(entity.id, "relates_to", "in");
  let docs = 0;
  /** Unordered `a|b` keys, so one disagreement seen from both ends counts once. */
  const conflictPairs = new Set<string>();
  /** Records in this namespace actually attached — `incoming` counts edges, including foreign ends. */
  let attached = 0;
  // The row's own staleness counts: a service record nobody re-synced is the first thing that has rotted,
  // and a catalog that reported 0 stale next to its own expired row would be the lie this screen exists to
  // prevent.
  let stale = status === "stale" ? 1 : 0;
  let latestDecision: CatalogRow["latestDecision"];
  for (const edge of incoming) {
    const rec = await port.getEntity(edge.from);
    if (!rec || normalizeNs(rec.ns) !== ns) continue;
    const recStatus = effectiveStatus(rec, ontology, now);
    attached++;
    if (rec.type === "resource") docs++;
    if (recStatus === "stale") stale++;
    for (const c of await port.neighbors(rec.id, "conflicts_with"))
      conflictPairs.add([c.from, c.to].sort().join("|"));
    if (rec.type === "decision" && recStatus === "verified") {
      const at = rec.provenance.occurred_at;
      // Newest by the knowledge's own event time, not by the promotion — the same rule the briefing sort
      // uses, so "the latest decision" means one thing in this product.
      if (!latestDecision || at > latestDecision.at)
        latestDecision = {
          id: rec.id,
          summary: String(rec.attributes.conclusion ?? ""),
          at,
        };
    }
  }
  return {
    id: entity.id,
    type: entity.type,
    name: String(entity.attributes.name ?? entity.id),
    status,
    citation: citation(entity),
    actor: entity.provenance.actor,
    occurred_at: entity.provenance.occurred_at,
    version: entity.version,
    ...(typeof entity.attributes.lifecycle === "string"
      ? { lifecycle: entity.attributes.lifecycle }
      : {}),
    ...(typeof entity.attributes.repo === "string"
      ? { repo: entity.attributes.repo }
      : {}),
    owners,
    dependsOn: dependsOn.length,
    dependents: dependents.length,
    docs,
    attached,
    ...(latestDecision ? { latestDecision } : {}),
    stale,
    conflicts: conflictPairs.size,
  };
}
