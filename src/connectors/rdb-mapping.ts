// RDB read-mapping connector (PLAN 8.3, BACKENDS "Traditional-DB read-mapping") — the enterprise wedge.
// Exposes an existing RDB as ontology entities with no migration and no bidirectional sync (read-only).
//
// DESIGN EXCEPTION vs ingest(): the capture connectors (github-pr, slack, notes) stage everything as a
// draft and let a human verify it. Read-mapping does NOT — the source RDB is already the org's system of
// record, so mapped rows bypass draft staging and land status='verified' directly. They STILL pass
// ontology validation (commit gate step 1); only the human-review step is skipped. This is why it is a
// separate function, not a Connector fed to ingest().
//
// Single-write-path invariant preserved: we never touch putEntity. We commit() (draft) then
// lifecycle.verify() (verified) — the exact pattern cmdInit uses to seed yoke:system. Reaching 'verified'
// through the allowed paths therefore costs two versions per write (draft v_n, verified v_n+1).
//
// Provenance caveat: commit() records prov {actor:'rdb', origin:'rdb:<table>'} on the draft version, but
// verify() (core, unmodifiable here) rewrites the promoted head's provenance.origin to 'lifecycle'. The
// rdb origin therefore lives on the draft history row and, durably, in attributes.external_id
// (`rdb:<table>:<pk>`), which is also the idempotency key.

import { CommitRejected, commit } from "../core/commit.js";
import type { Embedder } from "../core/embedding.js";
import { verify } from "../core/lifecycle.js";
import type { TypeDef } from "../core/ontology.js";
import type { Entity, Provenance } from "../core/types.js";
import type { StoragePort } from "../ports/storage.js";

/** A foreign key → relation. Target rows live in `fkTable` (defaults to the same table for self-referential FKs, e.g. manager_id). */
export interface RelationSpec {
  fkColumn: string;
  relType: string;
  fkTable?: string;
}

/** One table/view → entity-type mapping. `columns` maps sqlColumn → attributeName. */
export interface MappingSpec {
  table: string;
  entityType: string;
  idColumn: string;
  columns: Record<string, string>;
  relations?: RelationSpec[];
  /**
   * Column holding when the row's fact became true (`updated_at`, `decided_on`, …). Optional.
   *
   * Without it the import clock is used, so the type's TTL counts from the sync rather than from the
   * source — a mapped table never goes stale and never reaches `review --stale`, whatever its rows
   * actually say. Opt-in because only the operator knows which column means "when this was true".
   */
  occurredAtColumn?: string;
}

/** query is injected so the connector is driver-agnostic (Postgres via rdb-pg, sqlite in tests/CLI). */
export interface RdbMappingConnector {
  query: (sql: string) => Promise<Record<string, unknown>[]>;
  mapping: MappingSpec[];
}

export interface MappedResult {
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}

export function makeRdbMappingConnector(
  opts: RdbMappingConnector,
): RdbMappingConnector {
  return opts;
}

const externalId = (table: string, pk: unknown): string =>
  `rdb:${table}:${String(pk)}`;

/** Find an already-ingested entity by its external_id (FTS candidates, then exact match — same as ingest.ts). */
async function findByExternalId(
  port: StoragePort,
  extId: string,
  ns?: string | null,
): Promise<Entity | null> {
  // Tenant-scoped, like ingest.ts's probe: two namespaces may map the same source table, and an
  // unscoped lookup would treat one tenant's row as the other's and re-version it.
  const hits = await port.search({ text: extId, ns });
  return hits.find((e) => e.attributes.external_id === extId) ?? null;
}

/** True when every mapped attribute (incl. external_id) already matches the stored entity — nothing to re-version. */
function unchanged(existing: Entity, next: Record<string, unknown>): boolean {
  return Object.keys(next).every(
    (k) => JSON.stringify(existing.attributes[k]) === JSON.stringify(next[k]),
  );
}

/**
 * Ingest mapped RDB rows as verified entities (+ FK relations). See file header for the design exception.
 * @param now ISO 8601 — injected (core does not create time).
 */
export async function ingestMapped(
  port: StoragePort,
  ontology: TypeDef[],
  connector: RdbMappingConnector,
  now: string,
  ns?: string | null,
  embedder?: Embedder,
): Promise<MappedResult> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const idByExtId = new Map<string, string>();

  /** `at` is the row's own instant when the mapping names a column for it, else the import clock. */
  const prov = (table: string, at?: string): Provenance => ({
    actor: "rdb",
    origin: `rdb:${table}`,
    occurred_at: at ?? now,
  });

  /** A source column's value as an ISO instant, or undefined when it is not one. */
  const rowInstant = (row: Record<string, unknown>, col?: string) => {
    if (!col) return undefined;
    const raw = row[col];
    if (raw instanceof Date) return raw.toISOString();
    if (typeof raw === "number" || typeof raw === "string") {
      const ms = Date.parse(String(raw));
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
    return undefined;
  };

  // Query each table once; reused by both passes.
  // ceiling: `SELECT *` over an operator-supplied table name. The mapping file is trusted operator
  // config (not end-user input), so raw identifier interpolation is acceptable here; add quoting/allowlist
  // if the mapping ever becomes user-facing.
  const tables = await Promise.all(
    connector.mapping.map(async (spec) => ({
      spec,
      rows: await connector.query(`SELECT * FROM ${spec.table}`),
    })),
  );

  // Pass 1 — entities. Build the external_id → yoke id map for pass 2.
  for (const { spec, rows } of tables) {
    // The primary key column, checked ONCE against the first row rather than per row: a typo'd `idColumn`
    // is a mapping-file mistake, not a data one. Every row would yield the same `rdb:<table>:undefined`,
    // and because this path re-versions on a key match, distinct rows would collapse into one entity's
    // version chain with the last row winning. Refusing the whole spec names the fix; refusing row by row
    // would bury it in identical errors.
    if (rows.length > 0 && !(spec.idColumn in rows[0])) {
      console.error(
        `rdb: ${spec.table} has no column "${spec.idColumn}" — ` +
          `mapped columns are ${Object.keys(rows[0]).join(", ")}. Nothing from this table was imported.`,
      );
      errors++;
      continue;
    }
    for (const row of rows) {
      // A NULL primary key in an actual row. Same consequence, different cause, so it is skipped rather
      // than aborting the table.
      if (row[spec.idColumn] === null || row[spec.idColumn] === undefined) {
        console.error(
          `rdb: skipped a ${spec.table} row whose ${spec.idColumn} is null — it cannot be identified`,
        );
        errors++;
        continue;
      }
      const extId = externalId(spec.table, row[spec.idColumn]);
      const attributes: Record<string, unknown> = { external_id: extId };
      for (const [col, attr] of Object.entries(spec.columns)) {
        attributes[attr] = row[col];
      }
      const existing = await findByExternalId(port, extId, ns);
      if (existing && unchanged(existing, attributes)) {
        idByExtId.set(extId, existing.id);
        skipped++;
        continue;
      }
      try {
        const at = rowInstant(row, spec.occurredAtColumn);
        const { entity } = await commit(
          port,
          ontology,
          { type: spec.entityType, attributes },
          prov(spec.table, at),
          // Freshness is measured from `last_confirmed`, so the row's own instant has to reach it too.
          at ?? now,
          existing
            ? { existingId: existing.id, ns, embedder }
            : { ns, embedder },
        );
        await verify(port, [entity.id], "rdb", at ?? now, ns);
        idByExtId.set(extId, entity.id);
        if (existing) updated++;
        else added++;
      } catch (e) {
        if (e instanceof CommitRejected) {
          // Ontology-invalid row: surface it, keep going (one bad row must not abort the whole sync).
          console.error(`rdb: rejected ${extId}: ${e.message}`);
          errors++;
          continue;
        }
        throw e;
      }
    }
  }

  // Pass 2 — FK relations (after all entities exist so targets resolve regardless of table/row order).
  for (const { spec, rows } of tables) {
    if (!spec.relations?.length) continue;
    for (const row of rows) {
      const fromId = idByExtId.get(externalId(spec.table, row[spec.idColumn]));
      if (!fromId) continue; // source row was rejected in pass 1
      for (const rel of spec.relations) {
        const fkVal = row[rel.fkColumn];
        if (fkVal === null || fkVal === undefined) continue;
        const targetExt = externalId(rel.fkTable ?? spec.table, fkVal);
        const toId =
          idByExtId.get(targetExt) ??
          (await findByExternalId(port, targetExt, ns))?.id;
        if (!toId) {
          console.error(
            `rdb: skip relation ${rel.relType} from ${externalId(spec.table, row[spec.idColumn])}: target ${targetExt} not found`,
          );
          continue;
        }
        // Idempotent: skip if this exact edge already exists (commit has no dedup for relations).
        const existingEdges = await port.neighbors(fromId, rel.relType, "out");
        if (existingEdges.some((r) => r.to === toId)) continue;
        // Relations pass the gate as drafts and stay there: `getRelation` makes an edge readable by
        // id, but promotion still means nothing for one (no read filters on an edge's status — see the
        // ceiling in lifecycle.ts). Only mapped entities are the read-mapping's verified surface.
        try {
          await commit(
            port,
            ontology,
            { type: rel.relType, attributes: {}, from: fromId, to: toId },
            prov(spec.table),
            now,
            { ns },
          );
        } catch (e) {
          if (e instanceof CommitRejected) {
            console.error(
              `rdb: rejected relation ${rel.relType}: ${e.message}`,
            );
            errors++;
            continue;
          }
          throw e;
        }
      }
    }
  }

  return { added, updated, skipped, errors };
}
