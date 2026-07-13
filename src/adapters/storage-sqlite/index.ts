// storage-sqlite — the better-sqlite3 implementation of StoragePort (SPEC.md / PLAN 1.5).
// append-only: only (id, version) rows are added. FTS5 keeps just the latest version (delete+insert).
// sqlite-vec (vec0) provides embeddings/similar (PLAN 4.2) — latest version only (same policy as FTS).

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { serializeText } from "../../core/embedding.js";
import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type { StoragePort, TextQuery } from "../../ports/storage.js";

// The schema is a TS constant rather than a .sql file (simpler bundling). created_at is an
// internal column outside the Entity contract, so a DB default fills it — it is not a put argument.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (id, version)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS relations (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (id, version)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(id UNINDEXED, text);

-- Bypasses the gate. append-only: versions accumulate per name; load returns only the latest.
CREATE TABLE IF NOT EXISTS ontology_types (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  def TEXT NOT NULL,                 -- JSON (full TypeDef)
  PRIMARY KEY (name, version)
);
`;

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
}

interface RelationRow extends EntityRow {
  from_id: string;
  to_id: string;
}

function rowToEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    version: r.version,
    type: r.type,
    status: r.status as Entity["status"],
    attributes: JSON.parse(r.attributes),
    provenance: JSON.parse(r.provenance),
    last_confirmed: r.last_confirmed,
  };
}

function rowToRelation(r: RelationRow): Relation {
  return { ...rowToEntity(r), from: r.from_id, to: r.to_id };
}

export class SqliteStorage implements StoragePort {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  async init(): Promise<void> {
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.db.exec(SCHEMA);
  }

  // The vec0 table is created lazily on the first embedding insert. Its dimension (N) is fixed to
  // the first vector's length — providers differ in dimension and it is unknown before insertion,
  // which is more robust than fixing it via env.
  // ponytail: dimension is pinned to the first embedding. Switching to a provider with a different dimension requires rebuilding the vector table.
  private ensureVecTable(dim: number): void {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_vec'`,
      )
      .get();
    if (!exists) {
      this.db.exec(
        `CREATE VIRTUAL TABLE entity_vec USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}])`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  async putEntity(e: Entity): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO entities (id, version, type, status, attributes, provenance, last_confirmed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.version,
        e.type,
        e.status,
        JSON.stringify(e.attributes),
        JSON.stringify(e.provenance),
        e.last_confirmed,
      );
    // FTS keeps only the latest version: drop the id's row, then re-insert the latest version's text.
    const latest = this.db
      .prepare(
        `SELECT type, attributes FROM entities WHERE id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(e.id) as { type: string; attributes: string };
    this.db.prepare(`DELETE FROM entities_fts WHERE id = ?`).run(e.id);
    this.db
      .prepare(`INSERT INTO entities_fts (id, text) VALUES (?, ?)`)
      .run(e.id, serializeText(latest.type, latest.attributes));

    // Keep only the latest version's vector too (same delete+insert as FTS). Touch it only when an
    // embedding is present — re-putting a version without an embedding leaves the existing vector in
    // place (entities has no vector column, so the latest vector cannot be reconstructed).
    if (e.embedding) {
      this.ensureVecTable(e.embedding.length);
      this.db.prepare(`DELETE FROM entity_vec WHERE id = ?`).run(e.id);
      this.db
        .prepare(`INSERT INTO entity_vec (id, embedding) VALUES (?, ?)`)
        .run(
          e.id,
          Buffer.from(
            e.embedding.buffer,
            e.embedding.byteOffset,
            e.embedding.byteLength,
          ),
        );
    }
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const row =
      version === undefined
        ? this.db
            .prepare(
              `SELECT * FROM entities WHERE id = ? ORDER BY version DESC LIMIT 1`,
            )
            .get(id)
        : this.db
            .prepare(`SELECT * FROM entities WHERE id = ? AND version = ?`)
            .get(id, version);
    return row ? rowToEntity(row as EntityRow) : null;
  }

  async putRelation(r: Relation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO relations (id, version, type, status, attributes, provenance, last_confirmed, from_id, to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.version,
        r.type,
        r.status,
        JSON.stringify(r.attributes),
        JSON.stringify(r.provenance),
        r.last_confirmed,
        r.from,
        r.to,
      );
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const dirClause =
      dir === "out"
        ? "from_id = @id"
        : dir === "in"
          ? "to_id = @id"
          : "(from_id = @id OR to_id = @id)";
    const typeClause = relType === undefined ? "" : " AND type = @relType";
    // Return only latest-version relations (guards against append-only re-commits).
    const rows = this.db
      .prepare(
        `SELECT r.* FROM relations r
         WHERE r.version = (SELECT MAX(version) FROM relations WHERE id = r.id)
           AND ${dirClause}${typeClause}`,
      )
      .all({ id, relType }) as RelationRow[];
    return rows.map(rowToRelation);
  }

  async search(q: TextQuery): Promise<Entity[]> {
    // Wrap the user text as an FTS5 phrase to avoid syntax errors from special characters (-, :, *, etc.).
    // Prefix match (*): so a token carrying a trailing particle/suffix (common in agglutinative
    // languages like Korean) is still found by its stem — e.g. searching "parseArgs" matches "parseArgs<suffix>".
    const match = `"${q.text.replace(/"/g, '""')}"*`;
    const typeClause = q.type === undefined ? "" : " AND e.type = @type";
    const statusClause =
      q.status === undefined ? "" : " AND e.status = @status";
    const limitClause = q.limit === undefined ? "" : " LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities_fts f
         JOIN entities e ON e.id = f.id
           AND e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
         WHERE f.text MATCH @match${typeClause}${statusClause}${limitClause}`,
      )
      .all({
        match,
        type: q.type,
        status: q.status,
        limit: q.limit,
      }) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** KNN-nearest entities. Empty array if the vec0 table was never created (no embedding ever inserted).
   * Returned entities carry a restored .embedding — the gate computes cosine similarity to apply the threshold. */
  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_vec'`,
      )
      .get();
    if (!exists) return [];
    const query = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    const hits = this.db
      .prepare(
        `SELECT id, embedding FROM entity_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(query, k) as { id: string; embedding: Buffer }[];
    const out: Entity[] = [];
    for (const h of hits) {
      const e = await this.getEntity(h.id);
      if (!e) continue;
      const buf = h.embedding;
      out.push({
        ...e,
        embedding: new Float32Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ),
      });
    }
    return out;
  }

  // --- Adapter extensions outside StoragePort: ontology seed save/load (for CLI init) ---

  /** Append-only save of ontology definitions. Accumulates as the next version per name. */
  saveOntology(defs: TypeDef[]): void {
    const nextVersion = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ontology_types WHERE name = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO ontology_types (name, version, def) VALUES (?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: TypeDef[]) => {
      for (const def of rows) {
        const { v } = nextVersion.get(def.name) as { v: number };
        insert.run(def.name, v, JSON.stringify(def));
      }
    });
    tx(defs);
  }

  /** Filter latest-version entities by status (outside StoragePort — for CLI review / verify --all-drafts).
   * search requires text so it doesn't fit, and adding list(filter) to StoragePort would change the
   * contract, so this is an adapter extension method like saveOntology. */
  listByStatus(status: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.status = ?
         ORDER BY e.created_at`,
      )
      .all(status) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Filter entities by provenance.actor (outside StoragePort — for persona 6.1).
   * search is text-based and can't filter provenance, so it doesn't fit; same pattern as listByStatus.
   * The actor match spans the entire history (all versions) — even if verify updates the latest
   * version's provenance to the promoter, the original author's contribution is not lost (the
   * append-only history preserves the original author).
   * Returns the latest-version row of each matching id. */
  listByActor(actor: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.id IN (
             SELECT id FROM entities
             WHERE json_extract(provenance, '$.actor') = ?
           )
         ORDER BY e.created_at`,
      )
      .all(actor) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Latest-version relations of a given type (outside StoragePort — for CLI conflicts).
   * neighbors is scoped to a specific id and doesn't fit a global listing, so this is an adapter extension. */
  listRelationsByType(type: string): Relation[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM relations r
         WHERE r.version = (SELECT MAX(version) FROM relations WHERE id = r.id)
           AND r.type = ?
         ORDER BY r.created_at`,
      )
      .all(type) as RelationRow[];
    return rows.map(rowToRelation);
  }

  /** Load only the latest version per name, in first-registration order. */
  loadOntology(): TypeDef[] {
    const rows = this.db
      .prepare(
        `SELECT def FROM ontology_types t
         WHERE t.version = (SELECT MAX(version) FROM ontology_types WHERE name = t.name)
         ORDER BY (SELECT MIN(rowid) FROM ontology_types WHERE name = t.name)`,
      )
      .all() as { def: string }[];
    return rows.map((r) => JSON.parse(r.def) as TypeDef);
  }
}
