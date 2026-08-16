// Connector contract (PLAN 5.1). A connector is only a producer of EntityInput — storage must always
// go through the commit gate (ingest). Not a framework: one type plus one shared ingest function (ingest.ts) is all of it.

import type { EntityInput } from "../core/types.js";

/**
 * One item from a source: the knowledge, its idempotency key, and when the source says it happened.
 *
 * `occurredAt` is when the SOURCE says the fact became true. Without it the type's TTL counts from the
 * import, so an imported archive never goes stale, never appears in `review --stale`, and is injected as
 * current knowledge indefinitely.
 *
 * Optional, because not every source has an instant a reader would trust: a local transcript file has a
 * filesystem mtime, which is when someone last touched the file rather than when the meeting happened.
 * Absent means "the source does not say", and ingest falls back to the import clock — honest about being
 * an ingestion timestamp.
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
