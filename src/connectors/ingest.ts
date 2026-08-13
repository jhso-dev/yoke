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
 * The same comparison `rdb-mapping.unchanged` makes, and the reason it has to exist here too: presence
 * of the key was the whole check, so an EDITED source item was skipped. Measured on a meeting
 * transcript — one paragraph corrected from "cap webhook retries at 5 attempts" to "3 attempts
 * (CORRECTED)" and a section appended: re-ingesting reported "added 2, skipped 24", the database kept
 * the wrong number as v1, and the appended section arrived as a NEW record contradicting it. No
 * `supersedes`, no conflict flag, nothing saying a stored chunk no longer matched its source.
 *
 * Only the attributes the connector produced are compared. A reviewer who edited a record by hand has
 * changed something the source does not know about, and a re-ingest must not silently revert it.
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
 * Every connector interpolates a field from the source into its key, and none of them checked that the
 * field was there. Measured on the three that ingest through here:
 *
 * - A Slack history page with two messages missing `ts` produced `slack:C0PLATFORM:undefined` twice.
 *   The first was committed; the second was found by the idempotency probe, counted as `skipped`, and
 *   discarded. The lost message said "the shard rebalance runs at 02:00 UTC, not 02:00 KST" — a
 *   correction, silently dropped as a duplicate of an unrelated message.
 * - `github-pr` builds its key from `html_url` and `meeting-notes` from the file path, so both have the
 *   same shape whenever the field drifts.
 *
 * The rdb connector's version of this is worse and is guarded at its own call site: a typo'd `idColumn`
 * yields `rdb:employees:undefined` for EVERY row, and because that path re-versions on a key match, four
 * different people became one entity's version chain with the last row winning — reported as
 * "1 added, 3 updated", exit 0.
 *
 * A key that cannot identify anything is not a smaller success. Rejecting is right rather than
 * generating one, because a synthetic key makes the item un-reingestable and un-deduplicable forever.
 */
export function unusableKey(externalId: string): string | null {
  const bad = ["undefined", "null", "NaN", ""];
  const tail = externalId.slice(externalId.lastIndexOf(":") + 1);
  if (bad.includes(tail.trim()))
    return `external id has no identifying value: ${externalId} — the source item is missing the field the key is built from`;
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
    // Per item, not per run. One review comment with an empty body threw `CommitRejected` out of this
    // loop: three earlier comments were already committed and stayed, the NEXT pull page was never
    // fetched, and no `added/skipped` line was ever printed — the caller saw one stderr line and exit 1
    // with no way to know how much had landed. The rdb path already isolates per row (`errors` in
    // rdb-mapping); these three did not. A source item that cannot be recorded is one item's problem.
    try {
      const unusable = unusableKey(externalId);
      if (unusable) throw new CommitRejected("ontology", unusable);
      // Definitively set external_id in attributes (ingest is the single source of the idempotency key).
      const attributes = { ...input.attributes, external_id: externalId };
      const stored = await findByExternalId(port, externalId, ns);
      if (stored && sameContent(stored, attributes)) {
        skipped++;
        continue;
      }
      await commit(
        port,
        ontology,
        {
          ...input,
          attributes,
        },
        // `occurred_at` is when the SOURCE says it happened; `now` stays the ingestion clock. The two
        // were the same value, so the TTL counted from the import and an archive never aged.
        {
          actor,
          origin: `connector:${connector.name}`,
          occurred_at: occurredAt ?? now,
        },
        // `last_confirmed` too, since that is what freshness is measured from: a message from last year
        // confirmed as of today is a claim nobody made.
        occurredAt ?? now,
        // The embedder was never passed, so gate stages 3 and 4 could not run on this path even when
        // one was configured — the BULK path was the only one with duplicate and contradiction detection
        // permanently off, while the hand path at least says "no duplicate check ran". Measured: 67 notes
        // ingested as 67 records over 29 distinct statements, the same sentence stored eight times.
        //
        // A changed source item becomes a new VERSION of the record it changed, which is what
        // append-only means: the wrong number stays readable at v1 and the correction is v2, rather than
        // the correction arriving as a second record that contradicts the first.
        { ns, embedder, ...(stored ? { existingId: stored.id } : {}) },
      );
      if (stored) updated++;
      else added++;
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
