// Connector contract (PLAN 5.1). A connector is only a producer of EntityInput — storage must always
// go through the commit gate (ingest). Not a framework: one type plus one shared ingest function (ingest.ts) is all of it.

import type { EntityInput } from "../core/types.js";

/**
 * One item from a source: the knowledge, its idempotency key, and when the source says it happened.
 *
 * `occurredAt` exists because dropping it cost freshness. Every connector stamped the import time:
 * a Slack message from 2026-08-05 was stored with `occurred_at` and `last_confirmed` of the moment the
 * import ran, so the type's TTL counted from THEN — an imported archive never went stale, never appeared
 * in `review --stale`, and was injected as current knowledge indefinitely. The Slack `ts` was already in
 * hand at the line that built the key.
 *
 * Optional, because not every source has one a reader would trust: a local transcript file has a
 * filesystem mtime, which is when someone last touched the file rather than when the meeting happened.
 * Absent means "the source does not say", and ingest falls back to the import clock — which is at least
 * honest about being an ingestion timestamp.
 */
export type SourceItem = EntityInput & {
  externalId: string;
  /** ISO 8601, from the source. Omit when the source has no trustworthy instant. */
  occurredAt?: string;
};

/** External source → EntityInput stream. externalId is the idempotency key (ingest stores it as attributes.external_id). */
export type Connector = {
  name: string;
  pull(since?: string): AsyncIterable<SourceItem>;
};
