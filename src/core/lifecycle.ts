// lifecycle — status transitions and freshness (KNOWLEDGE-POLICY soft rules 4 & 7).
// verify/deprecate change status, not knowledge content, so they take a separate write
// path rather than the commit gate. The only direct putEntity calls live in this file.
// Time is injected — never call new Date() in core (SPEC: inject the clock).

import { readEntities, type StoragePort } from "../ports/storage.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Shared transition path. Reads every row in ONE batch, then appends a new version row each
 * (append-only). Provenance is refreshed to record the promote/retire action itself
 * (origin: 'lifecycle').
 *
 * The batch read replaced a `getEntity` per id (v5.5): a bulk verify of 54 rows from the review queue
 * was 54 round trips before the first write. It also moved the unknown-id refusal to BEFORE any write
 * — the loop used to throw partway through, leaving the ids it had already reached promoted, which is
 * a half-applied governance action nobody asked for. Writes stay one call each; the port has no batch
 * write, and append-only means each is a distinct new row.
 */
async function transition(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  status: Status,
): Promise<Entity[]> {
  const found = new Map(
    (await readEntities(port, ids)).map((e) => [e.id, e] as const),
  );
  // Distinct: the read is a batch, so a repeated id would otherwise apply the same `prev` twice and
  // write (id, version+1) twice — two governance rows for one action.
  const distinct = [...new Set(ids)];
  // Refuse the WHOLE batch before the first write — do not silently skip unknown ids either, since
  // promote/retire are explicit actions. TWO loops, not one: validating inside the write loop makes
  // `verify([known, "nope"])` throw with `known` already promoted, which is a half-applied governance
  // action nobody asked for.
  for (const id of distinct)
    if (!found.has(id))
      throw new Error(`cannot transition unknown entity: ${id}`);
  const out: Entity[] = [];
  for (const id of distinct) {
    const prev = found.get(id) as Entity;
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
 * Records that declare they rest on any of `ids` — one incoming `derived_from` hop (SPEC "Derivation").
 *
 * Retiring a record is not a repair unless what rests on it can be found. This is the stale queue's rule
 * one surface over: flagging decay does not fix it, handing it to the thing that has to change does.
 *
 * Entities rather than ids, because every caller renders this for a person to act on and a bare ULID is
 * not something anyone can act on.
 *
 * Namespace-filtered on the relation, for the reason `identitySet` is: `neighbors` takes no `ns`, so
 * without it an edge filed by one tenant reports a dependent in another.
 *
 * ponytail: one hop, not the transitive closure. A dependent's own dependents surface when THAT record is
 * retired in turn, so the walk is iterative by construction; add a closure if a real corpus turns up
 * chains deep enough that one hop misleads.
 */
export async function downstreamOf(
  port: StoragePort,
  ids: string[],
  ns?: string | null,
): Promise<Entity[]> {
  const wantNs = normalizeNs(ns);
  const dependents = new Set<string>();
  for (const id of new Set(ids))
    for (const r of await port.neighbors(id, "derived_from", "in"))
      if (normalizeNs(r.ns) === wantNs) dependents.add(r.from);
  // A record is never its own downstream. The front tier refuses to file a self-edge, but a hand-filed
  // `yoke link X derived_from X` reaches storage like any other relation.
  for (const id of ids) dependents.delete(id);
  return readEntities(port, [...dependents].sort());
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
 * Every stored version of `id`, **ascending by version**.
 *
 * The order is part of this function's contract now, and that is a fix rather than a tightening: it
 * used to say "any order", sqlite's `listHistory` returned `ORDER BY version ASC`, and the fallback
 * below counted DOWN from the latest. Two implementations obeying "any order" differently is a display
 * bug waiting for whichever backend the reader happens to be on — `yoke history` and the entity screen
 * both print this list as a timeline.
 *
 * `listHistory` is a YokeStore extension rather than a port method, so it is feature-detected — and it
 * is genuinely absent on a remote backend, because it is synchronous and the rows are across a network
 * (SPEC "Remote backends"). The fallback walks `getEntity(id, version)`, which is in the port and
 * therefore async; versions are a dense 1..n sequence because `transition` and the commit gate both
 * increment by one, so counting reaches all of them.
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
  // Sorted even on the extension path: the contract is this function's, not the adapter's, so a
  // backend whose extension returns another order cannot change what a caller sees.
  const byVersion = (rows: Entity[]) =>
    [...rows].sort((a, b) => a.version - b.version);
  if (ext.listHistory) return byVersion(ext.listHistory(id));
  const latest = await port.getEntity(id);
  if (!latest) return [];
  const out: Entity[] = [latest];
  for (let v = latest.version - 1; v >= 1; v--) {
    const e = await port.getEntity(id, v);
    if (e) out.push(e);
  }
  return byVersion(out);
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
