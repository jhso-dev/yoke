// Shared connector ingest (PLAN 5.1). Not core but a front-tier consumer — it iterates a connector's
// pull and routes each item through the commit gate (no bypass). Idempotency: externalId is stored as
// attributes.external_id, and on re-run it is looked up via FTS and skipped if already present.

import { commit } from "../core/commit.js";
import type { TypeDef } from "../core/ontology.js";
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
async function exists(
  port: StoragePort,
  externalId: string,
  ns?: string | null,
): Promise<boolean> {
  // Scoped to the tenant, because the answer is per tenant: two namespaces may legitimately hold the
  // same source item, and a probe that searched everywhere would report one tenant's copy as the other's
  // and skip the import.
  const hits = await port.search({ text: externalId, terms: "all", ns });
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
  ns?: string | null,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for await (const item of connector.pull(since)) {
    const { externalId, ...input } = item;
    if (await exists(port, externalId, ns)) {
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
      { ns },
    );
    added++;
  }
  return { added, skipped };
}
