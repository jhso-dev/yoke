// Shared connector ingest (PLAN 5.1). Not core but a front-tier consumer — it iterates a connector's
// pull and routes each item through the commit gate (no bypass). Idempotency: externalId is stored as
// attributes.external_id, and on re-run it is looked up via FTS and skipped if already present.

import { commit } from "../core/commit.js";
import type { TypeDef } from "../core/ontology.js";
import type { StoragePort } from "../ports/storage.js";
import type { Connector } from "./types.js";

/** Check whether an entity with this external_id exists. Fetch candidates via FTS, then match exactly (excludes false positives). */
async function exists(port: StoragePort, externalId: string): Promise<boolean> {
  const hits = await port.search({ text: externalId });
  return hits.some((e) => e.attributes.external_id === externalId);
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
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for await (const item of connector.pull(since)) {
    const { externalId, ...input } = item;
    if (await exists(port, externalId)) {
      skipped++;
      continue;
    }
    // Definitively set external_id in attributes (ingest is the single source of the idempotency key).
    await commit(
      port,
      ontology,
      {
        ...input,
        attributes: { ...input.attributes, external_id: externalId },
      },
      { actor, origin: `connector:${connector.name}`, occurred_at: now },
      now,
    );
    added++;
  }
  return { added, skipped };
}
