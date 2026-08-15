// commit gate — the only write path into storage (KNOWLEDGE-POLICY hard rules 1–3).
// The pipeline order is fixed. Time is injected — never call new Date() in core (SPEC: inject the clock).
// Stages 3 & 4 (duplicate/conflict, v0.4) run only when an embedder is injected and embedding
// succeeds. An embedding failure never blocks a commit (without a vector, duplicate detection is
// skipped to avoid false positives). No auto-merge, no auto-reject.
// Every entity commit also records its authorship as an authored_by edge (stage 4b) so that
// provenance is reachable by graph traversal — see the comment at that stage.

import { ulid } from "ulid";
import {
  ConflictError,
  readEntities,
  type StoragePort,
} from "../ports/storage.js";
import type { Embedder } from "./embedding.js";
import { resolveIndexKey, serializeText } from "./embedding.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import { validateInput } from "./ontology.js";
import type {
  Entity,
  EntityInput,
  Provenance,
  Relation,
  RelationInput,
} from "./types.js";

// ceiling: start with a single threshold constant (0.85). Move to per-type thresholds if precision problems show up in practice.
const DUP_THRESHOLD = 0.85;

/**
 * How many times a re-version retries after losing a `(id, version)` race (C1). Two processes that
 * re-version one id both compute `prev.version + 1`; one wins the primary-key contest and the other
 * gets a `ConflictError`, so it re-reads the latest version and tries again. Bounded, because an
 * unbounded retry under pathological contention is a hang, not a fix — five is far past the realistic
 * two-or-three writers and exhausting it surfaces the clean `ConflictError` rather than a raw SQL string.
 */
const MAX_VERSION_RETRIES = 5;

/**
 * Store an entity, retrying the version race (C1). On a `ConflictError` for a re-commit (existingId
 * set), re-read the latest version, recompute `version`, and try again up to the bound; a fresh id
 * (no existingId) cannot lose the race legitimately, so its conflict propagates unchanged.
 */
async function putEntityRetrying(
  port: StoragePort,
  entity: Entity,
  existingId: string | undefined,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await port.putEntity(entity);
      return;
    } catch (e) {
      if (
        !(e instanceof ConflictError) ||
        existingId === undefined ||
        attempt >= MAX_VERSION_RETRIES
      )
        throw e;
      const latest = await port.getEntity(existingId);
      entity.version = (latest?.version ?? entity.version) + 1;
    }
  }
}

export class CommitRejected extends Error {
  constructor(
    readonly reason: "ontology" | "provenance",
    message: string,
  ) {
    super(message);
    this.name = "CommitRejected";
  }
}

export interface CommitResult {
  entity: Entity | Relation;
  /** Existing entities with similarity >= threshold (no auto-merge — the caller decides). */
  duplicates: Entity[];
  /** Auto-created conflicts_with relations (on decision conflict). Both sides preserved, no auto-resolution. */
  conflicts?: Relation[];
  /** Why duplicates is empty: an embedding comparison ran vs. detection was skipped entirely.
   * Without a vector (no embedder, embedding failed, or similar unsupported), treating every
   * candidate as a duplicate yields too many false positives, so detection is skipped. */
  duplicateDetection: "embedding" | "skipped";
  /** True when this commit found the record already there and stored nothing. Only relations reach
   * this today (see the identity note in `commit`), and a caller that says "linked" either way is
   * telling someone they did something they did not. */
  existed?: boolean;
  /** The `relates_to` edge filed for `opts.attachTo`, if one was asked for. Reported rather than
   * assumed: an already-existing edge and a newly filed one are different facts to a caller that
   * pressed the button twice. */
  attached?: Relation;
  /**
   * Edges the gate could not write AFTER the record became durable — absent when everything landed.
   *
   * The record is stored first and its edges follow, so a storage failure in stage 4/4b/4c must not
   * throw out of `commit`: a caller told "rejected" about a record that exists doubles the corpus on
   * retry (the state `attachTo` exists to abolish). The commit is reported as what it is — partial — and
   * the entity in `entity` is real. Authorship is re-derivable with `yoke backfill`; a missing
   * attachment has to be filed again.
   */
  unrecorded?: string[];
}

interface CommitOpts {
  /** When set, a re-commit = current latest version + 1 (append-only, history preserved). */
  existingId?: string;
  /** Injected embedder. Without it, duplicate/conflict detection is SKIPPED — deliberately not an
   * FTS approximation (SPEC "Stage 3 has no FTS fallback"); only retrieval falls back to keywords. */
  embedder?: Embedder;
  /** Tenant namespace (PLAN-V2 10.1). The gate assigns it to the stored row; default = shared ns. */
  ns?: string | null;
  /**
   * This relation is the gate's own bookkeeping, not a claim a caller made — skip endpoint validation.
   *
   * Set by the two derived edges (`conflicts_with` at stage 4, `authored_by` at 4b) and by
   * `backfillAuthorship`. They are exempt because `provenance.actor` is "a person entity id OR an
   * agent identifier" (SPEC), so an `authored_by` target is routinely a handle no entity carries —
   * minting a person per unrecognised handle is the junk-drawer the connectors already refuse. A
   * derived edge must never be the reason the caller's own commit fails.
   */
  derived?: boolean;
  /**
   * Attach the new entity to this record with a `relates_to` edge, as ONE act with the entity.
   *
   * The target is checked before anything is stored, so a typo refuses the whole commit and leaves
   * nothing behind. Filing this edge as a separate `commit()` after the first returns would leave the
   * entity durable when the edge's endpoint check throws, so the caller is told "rejected" while the
   * record exists — and an agent that believes a rejection retries, doubling the corpus. One caller
   * intent, one outcome.
   *
   * Not `derived`: the caller asked for this edge by name, so an unresolvable target is the caller's
   * error to hear about, unlike the gate's own bookkeeping edges above.
   */
  attachTo?: string;
}

/** Whether actor/origin are non-empty strings and occurred_at is a real instant. */
function provenanceOk(p: Provenance): boolean {
  // Trimmed: a whitespace-only actor or origin is not a source, and mechanism 1 ("nothing enters
  // without a source") would be defeated by one space — the record enters, `graph` draws an `authored_by`
  // edge to an id no record carries, and the citation renders as `[fact:…@v1]    , <ts>`, an author-less
  // claim with an author-shaped hole where the name goes.
  const ok = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return ok(p.actor) && ok(p.origin) && isInstant(p.occurred_at);
}

/**
 * A string naming a real moment, UNAMBIGUOUSLY. Non-empty is not enough — three things have to hold:
 *
 * 1. It parses. `"yesterday"` does not, and every comparison against it is `Date.parse` → NaN → false,
 *    which never fails loudly: `versionAsOf` treats such a version as older than every instant,
 *    `isFresh` calls it expired forever, and `julianday` yields NULL so the row disappears from a
 *    bounded audit read and from a PITR copy.
 * 2. It is ISO 8601 SHAPED. `Date.parse` on anything else is implementation-defined by the spec — V8
 *    reads `08/14/2026`, another engine may read it differently or not at all.
 * 3. It names the same moment everywhere, so an offset (or `Z`) is required. `[T ]` with an optional
 *    offset is LOCAL time: the same input stores three different instants across three server timezones —
 *
 *      "2026-08-14 00:00:00"  UTC 00:00Z · Asia/Seoul 2026-08-13T15:00Z · America/New_York 04:00Z
 *      "2026-08-14T00:00:00"  identical spread
 *
 *    Nineteen hours of it, decided by an environment variable on the machine that happened to run the
 *    write. For a store whose job is saying when something was true, that is the hazard this regex
 *    refuses.
 *
 * A bare date (`2026-08-14`) stays legal: the spec defines the date-only form as UTC, so it means one
 * moment on every runtime — which is the whole test.
 */
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;
export function isInstant(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_8601.exec(v.trim());
  if (!m || Number.isNaN(Date.parse(v))) return false;
  // 4. The date EXISTS. The regex checks digit shape (`\d{2}` passes 30 and 31 in any month) and
  //    `Date.parse` does not refuse a day the calendar lacks — it rolls over: measured,
  //    `2026-02-30T00:00:00Z` parsed to March 2nd and `2026-04-31` to May 1st, so the gate stored a
  //    DIFFERENT day than the one written. Which instant the caller meant is unknowable — rejecting is
  //    the only answer that is not a guess recorded as provenance. Validated on the wall-clock fields
  //    (Date.UTC rolls over identically, so the check is whether the fields survive), which is
  //    offset-independent: an offset moves the instant, never the written day. Hours get the same
  //    check because `T24:30` rolls into the next day the same way.
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hour = m[5] === undefined ? 0 : Number(m[5]);
  const roundTrip = new Date(Date.UTC(y, mo - 1, d, hour));
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === mo - 1 &&
    roundTrip.getUTCDate() === d &&
    roundTrip.getUTCHours() === hour
  );
}

/**
 * The read boundaries' single implementation. `instantFlag` (CLI) and `instantParam` (web) each
 * reimplemented a laxer `Date.parse`-only check that accepted what the gate rejects — `2026-02-30`
 * (rolls to Mar 2), `"2026-08-14 00:00:00"` (timezone-dependent), `"0"`. This is the one strict
 * validator so the front tiers stop parsing the same thing a second, weaker way (CLAUDE.md: the
 * second place that parses calls the first). Throws an Error naming the ISO-8601 requirement, or
 * returns the canonical UTC ISO string — the value the front tiers already hand back.
 */
export function parseInstant(raw: unknown): string {
  if (!isInstant(raw))
    throw new Error(
      `must be an ISO 8601 instant, e.g. 2026-08-13T00:00:00Z (got ${JSON.stringify(raw)})`,
    );
  return new Date(Date.parse(raw)).toISOString();
}

/**
 * The write half of "every instant crosses one boundary" — the read halves are `instantFlag` (CLI) and
 * `instantParam` (web).
 *
 * A non-empty-STRING check would accept `"yesterday"` and `"08/14/2026"` and store them as the moment a
 * claim was made; downstream every comparison against them is `Date.parse` → NaN → false, which does not
 * fail loudly: `versionAsOf` treats such a version as older than every instant, `isFresh` reports it
 * expired forever, and `julianday` yields NULL so the row vanishes from a bounded audit read and from a
 * PITR copy. A timestamp that cannot be compared is not provenance.
 *
 * Normalized to UTC as well as validated, for the reason the read boundaries are: a VALID instant in
 * offset notation (`2026-08-14T09:00:00+09:00`) sorts by `localeCompare` nowhere near the same moment
 * written as `Z`, and the briefing order, `newestFirst` on the web, and the FTS-independent tiebreaks
 * all collate rather than parse. A gate is a trust boundary: what stops a third-party connector or a
 * library caller is the check here, not the convention the front tiers follow.
 *
 * The instant is unchanged — only its spelling — so "provenance is a record of what happened" holds.
 */
function normalizeProvenance(p: Provenance): Provenance {
  return {
    ...p,
    occurred_at: new Date(Date.parse(p.occurred_at)).toISOString(),
  };
}

/** Cosine similarity. Handles unnormalized vectors too (provider-independent scale). */
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * The knowledge-ingest gate. Validates an EntityInput/RelationInput, assigns governed fields, then stores it.
 * @param now ISO 8601. Assigned as last_confirmed (core does not create time).
 */
export async function commit(
  port: StoragePort,
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
  rawProv: Provenance,
  rawNow: string,
  opts?: CommitOpts,
): Promise<CommitResult> {
  // (1) Ontology validation.
  const v = validateInput(ontology, input);
  if (!v.ok) throw new CommitRejected("ontology", v.reason);

  // (2) Validate required provenance fields.
  if (!provenanceOk(rawProv))
    throw new CommitRejected(
      "provenance",
      "provenance requires non-empty actor and origin, and an occurred_at that is a real instant (ISO 8601)",
    );
  // `last_confirmed` is a timestamp the same comparisons read, so it crosses the same boundary.
  // `ingest` passes the SOURCE's clock here (an archive must age from when it happened), which is the
  // path a connector's spelling reaches this field by.
  if (!isInstant(rawNow))
    throw new CommitRejected(
      "provenance",
      `last_confirmed must be a real instant (ISO 8601), got ${JSON.stringify(rawNow)}`,
    );
  const prov = normalizeProvenance(rawProv);
  const now = new Date(Date.parse(rawNow)).toISOString();

  const existingId = opts?.existingId;
  const isRelation = "from" in input;
  const ns = normalizeNs(opts?.ns);

  // (2b) The attachment target, before anything is stored and before the embedder is paid for. An
  // entity plus its attachment is one thing the caller asked for; half of it is not a smaller success.
  //
  // Scoped to THIS commit's ns: `getEntity` is an id-based point read (ids are globally unique), so
  // without the ns check a `--scope <id-in-another-ns>` resolves to a record and the attachment is
  // filed — a `relates_to` edge in ns `other` pointing at an id no record in `other` carries, the
  // dangling endpoint the relation gate refuses. The 4c edge that lands is written in this ns, so its
  // target must live here.
  if (opts?.attachTo !== undefined && !isRelation) {
    const target = await port.getEntity(opts.attachTo);
    if (!target || normalizeNs(target.ns ?? null) !== ns)
      throw new CommitRejected(
        "ontology",
        `nothing to attach to: ${opts.attachTo} is not a record${ns !== null ? ` in namespace ${ns}` : ""} — the record was not created`,
      );
  }

  // (3) Look up similar entities → duplicate candidates. Relations are not subject to this.
  let duplicates: Entity[] = [];
  let embedding: Float32Array | null = null;
  let duplicateDetection: CommitResult["duplicateDetection"] = "skipped";
  if (!isRelation && opts?.embedder) {
    // The store's key variant, not this process's env — the FTS half of the index is written by the
    // adapter from the same recorded value, and two halves keyed differently is a mixed index.
    const text = serializeText(
      input.type,
      JSON.stringify(input.attributes),
      ontology,
      await resolveIndexKey(
        port,
        async () =>
          (await port.listEntities({ ns: opts?.ns, limit: 1 })).items.length ===
          0,
      ),
    );
    embedding = await opts.embedder(text);
    if (embedding && port.similar) {
      const candidates = await port.similar(embedding, 5);
      duplicates = candidates.filter(
        (c) =>
          c.id !== existingId &&
          c.embedding !== undefined &&
          cosine(embedding as Float32Array, c.embedding) >= DUP_THRESHOLD,
      );
      duplicateDetection = "embedding";
    }
    // embedding null (fallback) or similar unsupported → stays "skipped" (detection skipped, empty array).
  }

  // (5) Assign id/version/status/last_confirmed, then store. (This is stage 5 in the SPEC order,
  // but stage 4's conflicts_with references the new entity id, so we store first.)
  const prev = existingId ? await port.getEntity(existingId) : null;
  const governed = {
    id: existingId ?? ulid(),
    status: "draft" as const,
    version: prev ? prev.version + 1 : 1,
    last_confirmed: now,
    provenance: prov,
    // Include ns only when set — the default namespace leaves the field absent (opaque parity).
    ...(ns !== null ? { ns } : {}),
  };

  if (isRelation) {
    const rel = input as RelationInput;
    // Both endpoints have to be records. Non-empty is not enough: a typo'd id would store an edge to
    // nothing — `link <person> works_on 01ZZZ…` returning an id and exit 0, the graph drawing an arrow
    // at an id that was never a record. An edge is a claim about two things — filing one about a thing
    // that does not exist is not knowledge.
    //
    // ceiling: existence, not namespace agreement. An edge filed in one namespace may name a record
    // in another, which is dead data rather than a leak — every read path filters `ns` itself
    // (`neighbors` takes none, which is why `identitySet` and `downstreamOf` filter on the relation).
    // Tightening this to same-namespace needs the port to scope relations, not the gate to guess.
    // A record is not related to itself, and every relation type this ontology declares says something
    // that cannot be true of one thing: `A supersedes A`, `A conflicts_with A`, `A same_as A`, `A
    // derived_from A`. `lifecycle.ts` assumes the front tier refuses to file a self-edge, but a
    // hand-filed one reaches storage: `conflicts_with` on itself makes `yoke conflicts` print a record
    // disagreeing with itself, and after this commit's supersession filter a self-supersedes withholds a
    // record on its own authority.
    //
    // The gate, not the front tier, because this guard has to hold for every caller — `link`, the
    // browser, MCP and the connectors.
    if (rel.from === rel.to)
      throw new CommitRejected(
        "ontology",
        `a record cannot ${rel.type} itself: ${rel.from}`,
      );
    if (!opts?.derived) {
      const ends = await readEntities(port, [rel.from, rel.to]);
      for (const end of [rel.from, rel.to])
        if (!ends.some((e) => e.id === end))
          throw new CommitRejected(
            "ontology",
            `relation endpoint is not a record: ${end}`,
          );
    }
    // A relation's identity is (type, from, to) in a namespace — nothing else distinguishes one edge
    // from the same edge. Without this, filing the same link twice stores two rows with different ids,
    // the same actor and the same instant, and every reader counts one edge as many.
    //
    // ceiling: dedup ignores `attributes`, because no seeded relation type declares any. A relation
    // that carried them would need the versioning entities get through `existingId`, and there is no
    // way to name an existing edge today — declare that before giving a relation attributes.
    // A symmetric relation means the same thing read either way (see `symmetric` in the ontology), so
    // the edge already exists whichever end it was recorded from — otherwise "A relates_to B" and "B
    // relates_to A" are one claim in two rows, which is the duplicate this check exists to stop.
    const symmetric =
      ontology.find((d) => d.kind === "relation" && d.name === rel.type)
        ?.symmetric === true;
    // ceiling: this dedup is a `neighbors().find()` read followed by a `putRelation` write with no
    // serialization or uniqueness (C3, deliberately left this round). Two concurrent identical links
    // both read "absent" and both insert, so two durable rows exist for one edge — the same-process
    // idempotency this check gives is not concurrency-safe. Deferred because a real fix needs a UNIQUE
    // index that interacts with the (id, version) history model (a latest-version-only partial index),
    // which is a schema decision out of scope. Upgrade path: that partial unique index, OR route this
    // check-and-write through the same `withCriticalSection` write-lock hook the connector uses for C4.
    const already = (
      await port.neighbors(rel.from, rel.type, symmetric ? undefined : "out")
    ).find(
      (r) =>
        (r.ns ?? null) === ns &&
        (symmetric
          ? (r.from === rel.from && r.to === rel.to) ||
            (r.from === rel.to && r.to === rel.from)
          : r.from === rel.from && r.to === rel.to),
    );
    if (already)
      return {
        entity: already,
        duplicates: [],
        duplicateDetection: "skipped",
        existed: true,
      };
    const relation: Relation = { ...rel, ...governed };
    await port.putRelation(relation);
    return { entity: relation, duplicates: [], duplicateDetection: "skipped" };
  }

  const entity: Entity = { ...input, ...governed };
  if (embedding) entity.embedding = embedding;
  // C1: the version was computed from a `prev` read that a concurrent re-commit may have raced.
  // putEntityRetrying re-reads and recomputes on a ConflictError so both writers land (serialized),
  // instead of surfacing a raw `UNIQUE constraint failed` to whoever lost.
  await putEntityRetrying(port, entity, existingId);

  // From here the record is DURABLE, so nothing below may throw its way out to the caller.
  //
  // Stages 4, 4b and 4c write edges after the entity is stored. A storage failure in any of them must
  // not propagate — the caller would hear "commit failed" about a record that exists, carrying no
  // `authored_by` edge and so invisible to persona anchors, the overview's author ranking and
  // `identitySet`, silently, because the only repair is a `backfill` nobody knows to run. This is the
  // state `attachTo` was introduced to abolish: told "rejected" while the record exists, an agent that
  // believes the rejection retries, and the corpus doubles.
  //
  // Reported instead. `unrecorded` names what could not be written, so a caller learns the commit was
  // partial rather than inferring success — and for the derived edges this is the policy the `derived`
  // option states: a derived edge must never be the reason the caller's own commit fails. `backfill`
  // re-derives authorship, which is what makes degrading safe here rather than merely convenient.
  const unrecorded: string[] = [];
  const alongside = async (what: string, write: () => Promise<void>) => {
    try {
      await write();
    } catch (e) {
      unrecorded.push(`${what}: ${(e as Error).message}`);
    }
  };

  // (4) Conflict detection — a decision-only heuristic. Among similar (duplicate-candidate)
  // decisions, a differing conclusion creates a conflicts_with. The only input to the judgment is
  // the conclusion text (the v1 ontology has no subject). Both sides preserved, no auto-resolution.
  // Relations must also pass the gate, so we reuse commit internally (relations skip stages 3 & 4,
  // so there is no infinite recursion).
  const conflicts: Relation[] = [];
  if (input.type === "decision") {
    const conclusion = String(input.attributes.conclusion ?? "");
    for (const dup of duplicates) {
      if (dup.type !== "decision") continue;
      if (String(dup.attributes.conclusion ?? "") === conclusion) continue;
      await alongside(`conflicts_with -> ${dup.id}`, async () => {
        const rel = await commit(
          port,
          ontology,
          {
            type: "conflicts_with",
            attributes: {},
            from: entity.id,
            to: dup.id,
          },
          prov,
          now,
          { ns, derived: true },
        );
        conflicts.push(rel.entity as Relation);
      });
    }
  }

  // (4b) Authorship as a graph edge. provenance.actor is a stored field, so a graph walk cannot see
  // it. Mirroring authorship as an authored_by relation makes "knowledge from this person" the same
  // one-hop walk as "knowledge in this collaboration": one mechanism, and it works on every conformant
  // backend.
  // Entities only (the inner call commits a relation, which returns above — no recursion), skipping
  // self-authorship, and idempotent per (entity, actor) so re-commits never pile up edges.
  // Skipped when the ontology in force does not declare authored_by: a tenant schema that never
  // registered the type has not opted into an authorship graph (persona there stays empty), and a
  // derived edge must never be the reason the caller's own commit fails.
  if (
    prov.actor !== entity.id &&
    ontology.some((t) => t.name === "authored_by")
  ) {
    await alongside(`authored_by -> ${prov.actor}`, async () => {
      const authored = await port.neighbors(entity.id, "authored_by", "out");
      if (!authored.some((r) => r.to === prov.actor))
        await commit(
          port,
          ontology,
          {
            type: "authored_by",
            attributes: {},
            from: entity.id,
            to: prov.actor,
          },
          prov,
          now,
          { ns, derived: true },
        );
    });
  }

  // (4c) The caller's attachment. Filed last so the edge never precedes the record it describes, and
  // through the ordinary gate so it inherits relation identity — `relates_to` is symmetric, so
  // attaching the same record twice is one edge, not two rows pointing opposite ways.
  // Not `derived`, so its failure is louder: the caller asked for this edge by name and gets it back
  // in `unrecorded` rather than in `attached`. It still may not throw — the entity is durable, and a
  // thrown attach would recreate the exact "rejected, but it exists" state this option was added to
  // abolish. The target was already proven to exist at stage 2b, so what reaches here is storage
  // failing, not the caller being wrong.
  let attached: Relation | undefined;
  if (opts?.attachTo !== undefined) {
    await alongside(`relates_to -> ${opts.attachTo}`, async () => {
      const link = await commit(
        port,
        ontology,
        {
          type: "relates_to",
          attributes: {},
          from: entity.id,
          to: opts.attachTo as string,
        },
        prov,
        now,
        { ns },
      );
      attached = link.entity as Relation;
    });
  }

  return {
    entity,
    duplicates,
    duplicateDetection,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(unrecorded.length > 0 ? { unrecorded } : {}),
    ...(attached ? { attached } : {}),
  };
}
