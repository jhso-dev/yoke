// lifecycle — status transitions and freshness (KNOWLEDGE-POLICY soft rules 4 & 7).
// verify/deprecate change status, not knowledge content, so they take a separate write
// path rather than the commit gate. The only direct putEntity calls live in this file.
// Time is injected — never call new Date() in core (SPEC: inject the clock).

import {
  ConflictError,
  readEntities,
  type StoragePort,
} from "../ports/storage.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

const DAY_MS = 86_400_000;

/** Bounded retry for the `(id, version)` race (C2), mirroring commit's MAX_VERSION_RETRIES. */
const MAX_VERSION_RETRIES = 5;

/**
 * Shared transition path. Reads every row in ONE batch, then appends a new version row each
 * (append-only). Provenance is refreshed to record the promote/retire action itself
 * (origin: 'lifecycle').
 *
 * ONE batch read, not a `getEntity` per id: a bulk verify of 54 rows from the review queue would
 * otherwise be 54 round trips before the first write. Writes stay one call each — the port has no
 * batch write, and append-only means each is a distinct new row.
 */
async function transition(
  port: StoragePort,
  ids: string[],
  actor: string,
  rawNow: string,
  status: Status,
  ns?: string | null,
): Promise<Entity[]> {
  // The SECOND write path into storage, and it stamps both `last_confirmed` and a fresh `provenance`.
  // The gate normalizes its instants (commit.ts `normalizeProvenance`); a promotion that did not would
  // reintroduce mixed spellings into the same rows the gate had just canonicalized, and every
  // collating read — the briefing sort, `newestFirst`, the SQL windows — would disagree about which
  // record is newest. Rejecting garbage here rather than storing an uncomparable stamp, for the reason
  // the gate does: `Date.parse` → NaN never fails loudly, it just answers wrongly.
  if (Number.isNaN(Date.parse(rawNow)))
    throw new Error(
      `cannot record a transition at ${JSON.stringify(rawNow)}: not an ISO 8601 instant`,
    );
  const now = new Date(Date.parse(rawNow)).toISOString();
  const wantNs = normalizeNs(ns);
  const found = new Map(
    (await readEntities(port, ids))
      // The namespace is the tenant isolation unit (ENTERPRISE.md), and this path had no notion of it.
      // Every READ route filters ns; promotion and retirement did not, and RBAC only ever asked "may
      // you verify" and never "is this record yours". Measured on one database: a token scoped
      // `teamA:verify` promoted, read back the text of, and then retired a record belonging to teamB —
      // and because the audit row is written with the CALLER's ns, teamB's own trail showed nothing at
      // all. Three losses from one missing filter: the record mutated, its contents disclosed, and the
      // governance history of the tenant that owns it left blank.
      //
      // A foreign record is reported as unknown rather than as forbidden, deliberately. "exists, but
      // not yours" is an existence oracle: it lets one tenant enumerate another's ids by watching which
      // refusals change wording. Reads already answer this way (`GET /api/entity/:id` 404s for a
      // foreign id), so the two agree.
      .filter((e) => normalizeNs(e.ns) === wantNs)
      .map((e) => [e.id, e] as const),
  );
  // Distinct: the read is a batch, so a repeated id would otherwise apply the same `prev` twice and
  // write (id, version+1) twice — two governance rows for one action.
  const distinct = [...new Set(ids)];
  // Refuse the WHOLE batch before the first write — do not silently skip unknown ids either, since
  // promote/retire are explicit actions. TWO loops, not one: validating inside the write loop makes
  // `verify([known, "nope"])` throw with `known` already promoted, which is a half-applied governance
  // action nobody asked for.
  for (const id of distinct)
    if (!found.has(id)) {
      // An edge id gets its own refusal. `link` prints `draft` next to the id it returns, so the next
      // thing a reader tries is `verify <that id>` — and "cannot transition unknown entity" says the
      // store has never heard of a row it is holding. Name what it is and why the action does not
      // apply, rather than denying it exists.
      //
      // ceiling: relations are not promotable, and a `draft` edge is not weaker than a `verified` one
      // — no read filters on an edge's status, so an unverified relation routes a briefing exactly as
      // a verified one does. Making promotion mean something for edges is a KNOWLEDGE-POLICY decision
      // (should an unverified edge route injection at all?), not a missing branch here.
      if (await port.getRelation?.(id))
        throw new Error(
          `${id} is a relation, and relations are not promoted: no read filters on an edge's status, so this would change nothing`,
        );
      throw new Error(`cannot transition unknown entity: ${id}`);
    }
  const out: Entity[] = [];
  // The transition's job is to change STATUS, never content: it layers the status/version/last_confirmed/
  // provenance delta on top of whatever body is current. `buildNext(base)` builds that new version from a
  // given base — used first on the pre-race `prev`, then on the re-read latest inside the retry, so a
  // concurrent correction to the body survives instead of being resurrected by the stale `prev`.
  const buildNext = (base: Entity): Entity => ({
    ...base,
    status,
    version: base.version + 1,
    last_confirmed: now,
    provenance: { actor, origin: "lifecycle", occurred_at: now },
  });
  // Retiring what is already retired records nothing. `deprecate X` twice wrote v3 and v4, identical but
  // for the clock, and `history` then showed two retirements of one record — which also made the reason
  // ambiguous, since `retirementOf` takes the LAST deprecate row and both versions rendered it.
  //
  // Deliberately NOT applied to `verify`. Re-verifying looks like the same no-op and is not: moving
  // `last_confirmed` is the whole content of a re-confirmation, which is exactly the act the stale queue
  // asks for, and its stored status is already `verified`. Whether a blanket `verify` over fresh records
  // SHOULD refresh them is a governance question about who is allowed to say "still true", not a bug in
  // this branch — and answering it here would break the stale queue's own workflow.
  const alreadyRetired = (e: Entity | null | undefined): e is Entity =>
    !!e && e.status === status && status === "deprecated";
  for (const id of distinct) {
    const prev = found.get(id) as Entity;
    if (alreadyRetired(prev)) {
      out.push(prev);
      continue;
    }
    let next = buildNext(prev);
    // C2: a concurrent re-version of this id makes `prev.version + 1` collide, and the raw throw used
    // to land HERE — mid-loop, with earlier ids already promoted — so the caller heard "whole batch
    // failed" about a batch that was half-applied (the exact state the two-loop design above claims to
    // prevent). Retrying on the typed ConflictError re-reads the latest version and re-appends on top,
    // so a lost race is resolved rather than surfaced, and the batch does not half-apply.
    for (let attempt = 0; ; attempt++) {
      try {
        await port.putEntity(next);
        break;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= MAX_VERSION_RETRIES)
          throw e;
        // The winner of the race may have changed the BODY (so `next` must rebuild on the latest content,
        // not carry the stale `prev` forward and stamp it verified — B1) or may itself have RETIRED the
        // record (so the no-op guard must be re-evaluated against the head, not only the pre-race read —
        // B2). Re-read once, then decide against the latest.
        const latest = await port.getEntity(next.id);
        if (alreadyRetired(latest)) {
          next = latest; // record nothing new; return the head the winner already wrote.
          break;
        }
        next = buildNext(latest ?? next);
      }
    }
    out.push(next);
  }
  return out;
}

/** status → 'verified', last_confirmed = now. Appends a new version row (append-only).
 *
 * `ns` is the caller's tenant: an id outside it is refused as unknown. Omitting it means the default
 * shared namespace, which is what the single-user local path uses. */
export function verify(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  ns?: string | null,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "verified", ns);
}

/** status → 'deprecated'. Same mechanism as verify (append-only new version), same `ns` rule. */
export function deprecate(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  ns?: string | null,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "deprecated", ns);
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
 * ceiling: one hop, not the transitive closure — measured, not provisional
 * (eval/derivation-closure): across three simulated team corpora with chains to depth 4, not one
 * truly-invalidated record sat at graph distance >= 2, so the closure's entire target population was
 * empty while it added the only noise in the experiment. What limits this report is citation
 * coverage (over half the genuinely-affected records had no edge at all), which no walk depth fixes.
 * A dependent's own dependents still surface when THAT record is retired in turn.
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
 * The order is part of the contract rather than "any order": `yoke history` and the entity screen
 * both print this list as a timeline, and two implementations obeying "any order" differently is a
 * display bug waiting for whichever backend the reader happens to be on. The extension path returns
 * ascending and the fallback below counts DOWN from the latest, so both are sorted here.
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
/**
 * Whether `stamp` is at or before `at` — the comparison the TS as-of reads share.
 *
 * NOT the only one in the product: `exportUntil` and `listAudit` compare inside SQL, where this
 * function cannot reach. Those are correct because the front tiers normalize every caller-supplied
 * instant to UTC at the boundary (`instantFlag` in the CLI, `instantParam` on the web), which makes a
 * string comparison against stored `...Z` stamps sound. This function is the belt to that suspender:
 * core is also called directly (tests, embedders of the library), and a by-instant comparison stays
 * right even for a caller that skipped the boundary.
 *
 * It exists as a function because a second caller wrote the comparison out again rather than reuse the
 * one already here (`inject.meaningEdges`) — as a lexicographic `<=`, which put the same moment
 * spelled two ways on opposite sides of an edge. A shared operator is small enough to look not worth
 * extracting, which is exactly how two of them end up disagreeing.
 */
export function atOrBefore(stamp: string, at: string): boolean {
  return Date.parse(stamp) <= Date.parse(at);
}

export async function versionAsOf(
  port: StoragePort,
  id: string,
  at: string,
): Promise<Entity | null> {
  let best: Entity | null = null;
  for (const e of await listVersions(port, id)) {
    if (!atOrBefore(e.provenance.occurred_at, at)) continue;
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
 * ceiling: a walk with no index behind it — there cannot be one, since the TTL lives in the ontology
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
