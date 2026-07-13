// Connector contract (PLAN 5.1). A connector is only a producer of EntityInput — storage must always
// go through the commit gate (ingest). Not a framework: one type plus one shared ingest function (ingest.ts) is all of it.

import type { EntityInput } from "../core/types.js";

/** External source → EntityInput stream. externalId is the idempotency key (ingest stores it as attributes.external_id). */
export type Connector = {
  name: string;
  pull(since?: string): AsyncIterable<EntityInput & { externalId: string }>;
};
