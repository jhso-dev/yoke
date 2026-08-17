// scorecard — the checks, as queries (v7.4.2).
//
// Soundcheck is a rules engine. yoke needs none, because every fact the checks want is already in the
// schema: does this thing have a VERIFIED owner, a runbook, a decision inside its TTL, and how much of its
// knowledge has rotted. Four questions over the catalog read, and a table.
//
// The check no descriptor-driven portal can run is the one that matters: **a service whose owner record is
// stale is not green.** Both failure directions score — absence (nothing recorded) and rot (recorded once
// and never re-confirmed) — so a service cannot pass by having nothing said about it, which is how a
// scorecard built on presence alone rewards silence.
//
// No thresholds invented here. A check is pass/fail on a fact the database holds, and the score is how
// many passed — a weighting scheme would be a number chosen to be met (the same reasoning
// eval/retrieval-quality.ts gives for having no pass mark).

import type { StoragePort } from "../ports/storage.js";
import { type CatalogRow, catalog } from "./catalog.js";
import { effectiveStatus } from "./lifecycle.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";

export type CheckId = "owner" | "docs" | "decision" | "fresh";

export interface Check {
  id: CheckId;
  pass: boolean;
  /** Why it failed, in the terms of the record — never a generic "missing". */
  detail: string;
}

export interface ScorecardRow {
  id: string;
  name: string;
  type: string;
  checks: Check[];
  /** How many checks passed, out of `checks.length`. Unweighted, deliberately. */
  score: number;
  of: number;
}

/** A decision older than this is not evidence of a current decision. `decision`'s own seeded TTL. */
const DECISION_TTL_DAYS = 365;
const DAY_MS = 86_400_000;

/**
 * Score the catalog.
 *
 * Reads the same `catalog()` rows the portal renders, so a service cannot be green here and rotten there.
 * The one thing it looks up separately is the owner's own record — because "has an owner" and "has an owner
 * anyone can still ask" are different claims, and the second is the one this exists to make.
 */
export async function scorecard(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null; owner?: string },
): Promise<ScorecardRow[]> {
  const ns = normalizeNs(opts?.ns);
  const rows = await catalog(port, ontology, now, { ns, owner: opts?.owner });
  const out: ScorecardRow[] = [];
  /** Owner id -> its effective status, or null when no such record exists. Cached across rows. */
  const ownerState = new Map<string, string | null>();
  for (const row of rows) {
    const checks: Check[] = [
      await ownerCheck(port, ontology, now, ns, row, ownerState),
      {
        id: "docs",
        pass: row.docs > 0,
        detail:
          row.docs > 0 ? `${row.docs} attached` : "no runbook or docs attached",
      },
      decisionCheck(row, now),
      {
        id: "fresh",
        pass: row.stale === 0,
        // "Nothing has rotted" and "nothing is recorded" both leave `stale` at 0, and only the first is
        // an achievement. The check still passes — nothing IS stale — but the reason says which it is, so
        // a green freshness column beside an empty service cannot be read as health.
        detail:
          row.stale > 0
            ? `${row.stale} record${row.stale === 1 ? "" : "s"} past their TTL`
            : row.attached === 0
              ? "nothing recorded about it, so nothing to go stale"
              : "nothing stale",
      },
    ];
    out.push({
      id: row.id,
      name: row.name,
      type: row.type,
      checks,
      score: checks.filter((c) => c.pass).length,
      of: checks.length,
    });
  }
  // Worst first: a scorecard sorted by name is a list, and one sorted by score is a work queue.
  return out.sort(
    (a, b) =>
      a.score - b.score ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

async function ownerCheck(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  ns: string | null,
  row: CatalogRow,
  cache: Map<string, string | null>,
): Promise<Check> {
  if (!row.owner) return { id: "owner", pass: false, detail: "nobody owns it" };
  if (!cache.has(row.owner)) {
    const e = await port.getEntity(row.owner);
    cache.set(
      row.owner,
      e && normalizeNs(e.ns) === ns ? effectiveStatus(e, ontology, now) : null,
    );
  }
  const state = cache.get(row.owner) ?? null;
  // The check Backstage structurally cannot run. A descriptor names an owner and stops there; this asks
  // whether that owner is a record anyone can still reach, and whether it has been confirmed lately.
  if (state === null)
    return {
      id: "owner",
      pass: false,
      detail: `owner ${row.owner} is not a record here — nobody to ask`,
    };
  if (state === "stale")
    return {
      id: "owner",
      pass: false,
      detail: `owner ${row.owner} has not been confirmed since its TTL — not green`,
    };
  if (state === "deprecated")
    return {
      id: "owner",
      pass: false,
      detail: `owner ${row.owner} is retired`,
    };
  if (state === "draft")
    return {
      id: "owner",
      pass: false,
      detail: `owner ${row.owner} was never verified`,
    };
  return { id: "owner", pass: true, detail: row.owner };
}

function decisionCheck(row: CatalogRow, now: string): Check {
  if (!row.latestDecision)
    return {
      id: "decision",
      pass: false,
      // Absence scores, which is what stops a service with nothing recorded about it from passing.
      detail: "no verified decision recorded about it",
    };
  const age = Date.parse(now) - Date.parse(row.latestDecision.at);
  const days = Math.floor(age / DAY_MS);
  return {
    id: "decision",
    pass: days <= DECISION_TTL_DAYS,
    detail:
      days <= DECISION_TTL_DAYS
        ? `last decided ${days}d ago`
        : `last decision is ${days}d old, past the ${DECISION_TTL_DAYS}d TTL`,
  };
}
