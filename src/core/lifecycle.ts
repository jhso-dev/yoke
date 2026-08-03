// lifecycle — status transitions and freshness (KNOWLEDGE-POLICY soft rules 4 & 7).
// verify/deprecate change status, not knowledge content, so they take a separate write
// path rather than the commit gate. The only direct putEntity calls live in this file.
// Time is injected — never call new Date() in core (SPEC: inject the clock).

import type { StoragePort } from "../ports/storage.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Shared transition path. Reads with getEntity, then appends a new version row (append-only).
 * Provenance is refreshed to record the promote/retire action itself (origin: 'lifecycle').
 */
async function transition(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  status: Status,
): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const id of ids) {
    const prev = await port.getEntity(id);
    // Do not silently skip unknown ids — promote/retire are explicit actions.
    if (!prev) throw new Error(`cannot transition unknown entity: ${id}`);
    const next: Entity = {
      ...prev,
      status,
      version: prev.version + 1,
      last_confirmed: now,
      provenance: { actor, origin: "lifecycle", occurred_at: now },
    };
    await port.putEntity(next);
    out.push(next);
  }
  return out;
}

/** status → 'verified', last_confirmed = now. Appends a new version row (append-only). */
export function verify(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "verified");
}

/** status → 'deprecated'. Same mechanism as verify (append-only new version). */
export function deprecate(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "deprecated");
}

/**
 * Freshness check. Always fresh if the type has no ttl_days.
 * Otherwise fresh while last_confirmed + ttl_days >= now (millisecond arithmetic, no deps).
 */
export function isFresh(e: Entity, ontology: TypeDef[], now: string): boolean {
  const ttl = ontology.find((t) => t.name === e.type)?.ttl_days;
  if (ttl === undefined) return true;
  return Date.parse(e.last_confirmed) + ttl * DAY_MS >= Date.parse(now);
}

/**
 * Status at read time. If verified but no longer fresh, reports 'stale' (never persisted).
 * Otherwise returns the stored status as-is.
 */
export function effectiveStatus(
  e: Entity,
  ontology: TypeDef[],
  now: string,
): Status {
  if (e.status === "verified" && !isFresh(e, ontology, now)) return "stale";
  return e.status;
}

/**
 * Every stored version of `id`, newest-first-or-any-order (callers select, they do not assume).
 *
 * `listHistory` is a YokeStore extension rather than a port method, so it is feature-detected. The
 * fallback walks `getEntity(id, version)` down from the latest — versions are a dense 1..n sequence
 * because `transition` and the commit gate both increment by one, so counting down reaches all of them
 * using only port methods.
 *
 * One copy: `backfillAuthorship` had its own feature-detect that settled for the latest version alone
 * on a backend without the extension, which credited a promoter as the author of everything they
 * promoted — the very thing its comment says reading only the latest row would do. Two copies of a
 * capability probe is how display.ts's `summarize` drifted, and this is the same shape.
 */
export async function listVersions(
  port: StoragePort,
  id: string,
): Promise<Entity[]> {
  const ext = port as StoragePort & {
    listHistory?: (id: string) => Entity[];
  };
  if (ext.listHistory) return ext.listHistory(id);
  const latest = await port.getEntity(id);
  if (!latest) return [];
  const out: Entity[] = [latest];
  for (let v = latest.version - 1; v >= 1; v--) {
    const e = await port.getEntity(id, v);
    if (e) out.push(e);
  }
  return out;
}

/**
 * The version of `id` that was current at `at` — the highest whose provenance timestamp is at or
 * before it. null when the record did not exist yet.
 *
 * This is the whole of "what was true then". Rows are append-only and a transition writes a new
 * version (see `transition` above), so the status a record had at any past instant is already stored;
 * nothing but this lookup was missing. Reading the LATEST version and judging its freshness against a
 * past date gets the important case exactly backwards — a decision retired last week would report as
 * deprecated for a question about last month, when it was the answer.
 */
export async function versionAsOf(
  port: StoragePort,
  id: string,
  at: string,
): Promise<Entity | null> {
  const ms = Date.parse(at);
  let best: Entity | null = null;
  for (const e of await listVersions(port, id)) {
    if (Date.parse(e.provenance.occurred_at) > ms) continue;
    if (!best || e.version > best.version) best = e;
  }
  return best;
}

/** How many verified rows one page of the stale walk examines. Independent of the caller's `limit`,
 * which counts stale rows found — in a healthy corpus most verified records are fresh, so the two
 * numbers are not the same size. */
const STALE_SCAN_PAGE = 500;

/**
 * The verified records that have aged past their type's TTL — the queue SPEC promised from v1 and
 * nothing ever built ("Viewing stale is the job of review/CLI").
 *
 * `stale` is computed, never stored, so this cannot be `listEntities({status:'stale'})`: the walk has
 * to look at verified rows and apply `effectiveStatus` to each. That makes it the one governance
 * listing whose cost is proportional to the corpus rather than to the answer, so it is bounded and
 * says what it did:
 * - `next` resumes the SCAN, so it is the last row examined — not the last stale row found. Paging
 *   from the last hit would skip every fresh record between them and lose the rest of the queue.
 * - `scanned` is how many verified rows it read to find these. "12 stale among the first 5,000
 *   verified" is honest; "12 stale" after quietly giving up is not.
 *
 * ponytail: a walk with no index behind it — there cannot be one, since the TTL lives in the ontology
 * and freshness moves with the clock. If a corpus ever makes this too slow, the fix is a materialized
 * `expires_at` per row maintained by verify, not a smarter walk.
 */
export async function staleEntities(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null; type?: string; limit?: number; after?: string },
): Promise<{ items: Entity[]; next: string | null; scanned: number }> {
  const items: Entity[] = [];
  let scanned = 0;
  let after = opts?.after;
  for (;;) {
    const page = await port.listEntities({
      ns: opts?.ns,
      type: opts?.type,
      status: "verified",
      after,
      limit: STALE_SCAN_PAGE,
    });
    for (const e of page.items) {
      scanned++;
      if (effectiveStatus(e, ontology, now) !== "stale") continue;
      items.push(e);
      // Stop mid-page on purpose, and hand back THIS row as the cursor so the next call re-examines
      // nothing and skips nothing.
      if (opts?.limit !== undefined && items.length >= opts.limit)
        return { items, next: e.id, scanned };
    }
    if (page.next === null) return { items, next: null, scanned };
    after = page.next;
  }
}
