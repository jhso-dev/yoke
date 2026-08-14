// Connector contract (PLAN 5.1). A connector is only a producer of EntityInput — storage must always
// go through the commit gate (ingest). Not a framework: one type plus one shared ingest function (ingest.ts) is all of it.

import type { EntityInput } from "../core/types.js";

/**
 * External source → EntityInput stream. externalId is the idempotency key (ingest stores it as
 * attributes.external_id).
 *
 * `occurredAt` is when the source says this was said, and it is optional because not every source
 * knows: ingest falls back to the run clock. A connector that DOES know must pass it, because
 * `provenance.occurred_at` is what `--as-of` rewinds against and what orders one claim before
 * another. Stamping the ingest time instead makes every record of a run simultaneous, which reads
 * as a corpus in which nothing ever changed.
 */
export type Connector = {
  name: string;
  pull(
    since?: string,
  ): AsyncIterable<EntityInput & { externalId: string; occurredAt?: string }>;
};
