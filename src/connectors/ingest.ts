// Shared connector ingest (PLAN 5.1). Not core but a front-tier consumer — it iterates a connector's
// pull and routes each item through the commit gate (no bypass). Idempotency: externalId is stored as
// attributes.external_id, and on re-run it is looked up via FTS and skipped if already present.

import { CommitRejected, commit } from "../core/commit.js";
import type { Embedder } from "../core/embedding.js";
import type { TypeDef } from "../core/ontology.js";
import type { Entity } from "../core/types.js";
import type { StoragePort } from "../ports/storage.js";
import type { Connector } from "./types.js";

/**
 * Check whether an entity with this external_id exists. Fetch candidates via FTS, then match exactly
 * (excludes false positives).
 *
 * `terms: "all"` because this is a lookup, not a question. An external id is many tokens
 * (`https://github.com/acme/widgets/pull/12#discussion_r998877` is ten), and SPEC search clause 8
 * makes a long query a disjunction — which for a probe means scoring every record that shares the
 * word "github" and materializing a thousand of them to find the one row already known by name.
 * Measured at 1M entities: 292 ms and 1,000 rows per ingested item, against 34 ms and 0.
 */
async function findByExternalId(
  port: StoragePort,
  externalId: string,
  ns?: string | null,
): Promise<Entity | null> {
  // Scoped to the tenant, because the answer is per tenant: two namespaces may legitimately hold the
  // same source item, and a probe that searched everywhere would report one tenant's copy as the other's
  // and skip the import.
  const hits = await port.search({ text: externalId, terms: "all", ns });
  return hits.find((e) => e.attributes.external_id === externalId) ?? null;
}

/**
 * Whether every attribute this pull produced already matches what is stored.
 *
 * Compares only the pulled keys, not mere presence of the key: a source EDIT must re-version, not be
 * skipped as already-present nor arrive as a contradicting new record. This is the boundary the write
 * side draws (see the merge at the call site) — the connector's authority ends at the fields it emits,
 * so a key it no longer produces is neither compared nor overwritten. Comparing everything stored would
 * make every run after a mapping change report a difference it cannot resolve. Same comparison as
 * `rdb-mapping.unchanged`.
 */
function sameContent(stored: Entity, next: Record<string, unknown>): boolean {
  return Object.keys(next).every(
    (k) => JSON.stringify(stored.attributes[k]) === JSON.stringify(next[k]),
  );
}

/** What one ingest run did. `rejected` names the items that could not be recorded, and why. */
export interface IngestResult {
  added: number;
  /** Source items whose content had changed: committed as a new version (append-only), not overwritten. */
  updated: number;
  skipped: number;
  /** Present only when something was refused — absent means every item was accounted for. */
  rejected?: string[];
}

/**
 * Whether an external id can actually identify one source item.
 *
 * Every connector interpolates a source field into its key (`github-pr` from `html_url`, `slack` from
 * `ts`, `meeting-notes` from the file path). When that field is missing the key collapses to a sentinel
 * like `slack:C0PLATFORM:undefined`, which collides for every item that lost the same field — the second
 * is skipped as a duplicate of the first. A synthetic key also makes the item un-reingestable and
 * un-deduplicable forever, so reject it rather than generate one. (The rdb path guards its own `idColumn`
 * at its call site.)
 */
function unusableKey(externalId: unknown): string | null {
  const bad = new Set(["undefined", "null", "NaN", ""]);
  const noValue = (shown: string) =>
    `external id has no identifying value: ${shown} — the source item is missing the field the key is built from`;
  // Guard the OPERATION, not just the sentinel literals: a key that is not a non-empty string cannot
  // identify anything (an absent `html_url` makes `externalId` itself undefined). Returned as a message,
  // so the call site raises it as a per-item `CommitRejected` rather than throwing out of the loop.
  if (typeof externalId !== "string" || externalId.trim() === "")
    return noValue(String(externalId));
  // The interpolated field is not always the tail: meeting-notes puts it before `#` (`file:${rel}#${i}`)
  // and slack has two (`slack:${channel}:${ts}`). Split on both template delimiters and reject if ANY
  // segment is a sentinel a missing field leaves behind. Not split on `/`, so a github `html_url` whose
  // path legitimately contains `null` stays one segment and is not a false positive.
  if (externalId.split(/[:#]/).some((s) => bad.has(s.trim())))
    return noValue(externalId);
  return null;
}

/**
 * Route a connector's pull through the commit gate. Commit as draft if absent, skip if present.
 * @param now ISO 8601 (core does not create time — the front tier injects it).
 */
export async function ingest(
  port: StoragePort,
  ontology: TypeDef[],
  connector: Connector,
  actor: string,
  now: string,
  since?: string,
  ns?: string | null,
  embedder?: Embedder,
): Promise<IngestResult> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const rejected: string[] = [];
  for await (const item of connector.pull(since)) {
    const { externalId, occurredAt, ...input } = item;
    // Per item, not per run: a source item that cannot be recorded is one item's problem. Without this
    // try, one CommitRejected throws out of the loop, abandoning every later item and the next pull page
    // and losing the added/skipped tally. (The rdb path isolates per row the same way — `errors` in rdb-mapping.)
    try {
      // C4: findByExternalId then commit is a check-then-write. Without serialization two concurrent
      // ingests of one source item both read "absent" and both insert, leaving the stale claim AND its
      // correction as two live records with no supersedes. Run probe-and-commit as ONE critical section
      // so the second ingest sees the first's committed row and takes the updated/skipped path. Feature-
      // detected to keep ingest adapter-independent (invariant 1): a backend that cannot serialize a
      // multi-statement section runs the body directly.
      const handleItem = async (): Promise<void> => {
        const unusable = unusableKey(externalId);
        if (unusable) throw new CommitRejected("ontology", unusable);
        // Definitively set external_id in attributes (ingest is the single source of the idempotency key).
        const pulled = { ...input.attributes, external_id: externalId };
        const stored = await findByExternalId(port, externalId, ns);
        if (stored && sameContent(stored, pulled)) {
          skipped++;
          return;
        }
        // Stored attributes UNDER the pulled ones, so a re-ingest overwrites what the source owns and
        // keeps what it does not. When a connector's field set narrows between runs (an `--attr` mapping
        // edited to drop a column, an `idColumn`/`occurredAtColumn` retargeted), the merge keeps the
        // dropped fields on the head version rather than removing them — data must not vanish from an
        // append-only path because of a config edit. A connector that dropped a field is indistinguishable
        // from one that never had it, and silently deleting stored knowledge on that guess is the more
        // expensive mistake. `sameContent` compares only the pulled keys for the same reason: the
        // connector's authority ends at the fields it produces.
        const attributes = stored
          ? { ...stored.attributes, ...pulled }
          : pulled;
        await commit(
          port,
          ontology,
          {
            ...input,
            attributes,
          },
          // `occurred_at` is when the SOURCE says it happened; `now` stays the ingestion clock. Conflating
          // them makes the TTL count from the import, so an archive never ages.
          {
            actor,
            origin: `connector:${connector.name}`,
            occurred_at: occurredAt ?? now,
          },
          // `last_confirmed` too, since that is what freshness is measured from: a message from last year
          // confirmed as of today is a claim nobody made.
          occurredAt ?? now,
          // Pass the embedder so gate stages 3 and 4 (duplicate and contradiction detection) run on this
          // path when one is configured; without it a bulk sync stores the same statement many times over.
          //
          // A changed source item becomes a new VERSION of the record it changed — append-only: the wrong
          // number stays readable at v1 and the correction is v2, rather than a second record contradicting
          // the first. That version enters as `draft` like every commit, so a record someone had VERIFIED
          // drops out of injection until reviewed again: the content a reviewer vouched for is not the
          // content now stored, and carrying the promotion across would make "verified" mean "verified at
          // some earlier text". A sync can therefore quietly shrink what injection answers with — `updated`
          // in the result is the number to watch, and what `yoke review` is for.
          { ns, embedder, ...(stored ? { existingId: stored.id } : {}) },
        );
        if (stored) updated++;
        else added++;
      };
      if (port.withCriticalSection) await port.withCriticalSection(handleItem);
      else await handleItem();
    } catch (e) {
      if (!(e instanceof CommitRejected)) throw e;
      // Named, not counted. A number tells the caller something was dropped; the id and the reason tell
      // them WHICH source item to go and look at, which is the only actionable form.
      rejected.push(`${externalId}: ${e.message}`);
    }
  }
  return {
    added,
    updated,
    skipped,
    ...(rejected.length > 0 ? { rejected } : {}),
  };
}
