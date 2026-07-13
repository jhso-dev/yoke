// storage-sqlite — the better-sqlite3 implementation of StoragePort (SPEC.md / PLAN 1.5).
// append-only: only (id, version) rows are added. FTS5 keeps just the latest version (delete+insert).
// sqlite-vec (vec0) provides embeddings/similar (PLAN 4.2) — latest version only (same policy as FTS).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { serializeText } from "../../core/embedding.js";
import { normalizeNs } from "../../core/namespace.js";
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
  ns TEXT,                           -- tenant namespace (PLAN-V2 10.1); NULL = default shared ns
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
  ns TEXT,                           -- tenant namespace (PLAN-V2 10.1); NULL = default shared ns
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
  ns TEXT,                           -- tenant namespace (PLAN-V2 10.1); NULL = shared base ontology
  PRIMARY KEY (name, version)
);

-- Injection audit (PLAN 8.4). Append-only, written by front tiers only (core stays pure).
-- Entity mutations need no row here — the append-only version history already records them.
CREATE TABLE IF NOT EXISTS audit_log (
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL                   -- ISO 8601
);

-- API tokens (PLAN-V2 10.3). Only a salted sha256 of the secret is stored — never the plaintext.
CREATE TABLE IF NOT EXISTS tokens (
  name TEXT PRIMARY KEY,
  salt TEXT NOT NULL,                -- hex, per-token
  hash TEXT NOT NULL,                -- hex sha256(salt + secret)
  scopes TEXT NOT NULL,              -- JSON string[] (scope grammar parsed at the RBAC tier)
  created_at TEXT NOT NULL           -- ISO 8601
);
`;

/** One audit_log row. 'who saw what when' (ENTERPRISE.md) — inject/persona reads at the front tier. */
export interface AuditEvent {
  actor: string;
  action: string;
  detail: string;
  at: string;
}

/** A stored API token, sans secret (PLAN-V2 10.3) — for `yoke token list`. */
export interface TokenInfo {
  name: string;
  scopes: string[];
  created_at: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
  ns: string | null;
}

interface RelationRow extends EntityRow {
  from_id: string;
  to_id: string;
}

function rowToEntity(r: EntityRow): Entity {
  const e: Entity = {
    id: r.id,
    version: r.version,
    type: r.type,
    status: r.status as Entity["status"],
    attributes: JSON.parse(r.attributes),
    provenance: JSON.parse(r.provenance),
    last_confirmed: r.last_confirmed,
  };
  // Default namespace leaves the field absent (opaque parity with pre-10.1 rows).
  if (r.ns != null) e.ns = r.ns;
  return e;
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
    // Migration for DBs created before PLAN-V2 10.1: add the nullable ns column. Fresh DBs already
    // have it (in SCHEMA), so ADD COLUMN throws "duplicate column" — caught and ignored. NULL default
    // means every pre-existing row belongs to the default shared namespace (backward compatible).
    for (const table of ["entities", "relations", "ontology_types"]) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ns TEXT`);
      } catch {
        // column already exists — nothing to do.
      }
    }
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
        `INSERT INTO entities (id, version, type, status, attributes, provenance, last_confirmed, ns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.version,
        e.type,
        e.status,
        JSON.stringify(e.attributes),
        JSON.stringify(e.provenance),
        e.last_confirmed,
        e.ns ?? null,
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
        `INSERT INTO relations (id, version, type, status, attributes, provenance, last_confirmed, ns, from_id, to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.version,
        r.type,
        r.status,
        JSON.stringify(r.attributes),
        JSON.stringify(r.provenance),
        r.last_confirmed,
        r.ns ?? null,
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
    // Namespace isolation (PLAN-V2 10.1): `IS @ns` handles NULL (default ns sees only default rows).
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities_fts f
         JOIN entities e ON e.id = f.id
           AND e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
         WHERE f.text MATCH @match AND e.ns IS @ns${typeClause}${statusClause}${limitClause}`,
      )
      .all({
        match,
        ns: normalizeNs(q.ns),
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

  /** Append-only save of ontology definitions. Accumulates as the next version per name.
   * ns targets a tenant ontology (PLAN-V2 10.1); omitted = the shared base ontology.
   * Version numbering stays global per name (across namespaces) so the (name, version) primary
   * key never collides between a shared def and a tenant def of the same name. */
  saveOntology(defs: TypeDef[], ns?: string | null): void {
    const n = normalizeNs(ns);
    const nextVersion = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ontology_types WHERE name = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO ontology_types (name, version, def, ns) VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: TypeDef[]) => {
      for (const def of rows) {
        const { v } = nextVersion.get(def.name) as { v: number };
        insert.run(def.name, v, JSON.stringify(def), n);
      }
    });
    tx(defs);
  }

  /** Filter latest-version entities by status (outside StoragePort — for CLI review / verify --all-drafts).
   * search requires text so it doesn't fit, and adding list(filter) to StoragePort would change the
   * contract, so this is an adapter extension method like saveOntology. */
  listByStatus(status: string, ns?: string | null): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.status = ? AND e.ns IS ?
         ORDER BY e.created_at`,
      )
      .all(status, normalizeNs(ns)) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Filter entities by provenance.actor (outside StoragePort — for persona 6.1).
   * search is text-based and can't filter provenance, so it doesn't fit; same pattern as listByStatus.
   * The actor match spans the entire history (all versions) — even if verify updates the latest
   * version's provenance to the promoter, the original author's contribution is not lost (the
   * append-only history preserves the original author).
   * Returns the latest-version row of each matching id. */
  listByActor(actor: string, ns?: string | null): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.version = (SELECT MAX(version) FROM entities WHERE id = e.id)
           AND e.ns IS ?
           AND e.id IN (
             SELECT id FROM entities
             WHERE json_extract(provenance, '$.actor') = ?
           )
         ORDER BY e.created_at`,
      )
      .all(normalizeNs(ns), actor) as EntityRow[];
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

  /** All versions of an id, ascending (outside StoragePort — for CLI history, PLAN 8.4).
   * getEntity returns one version; the append-only rows ARE the change audit, this just exposes them. */
  listHistory(id: string): Entity[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE id = ? ORDER BY version ASC`)
      .all(id) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /** Append one injection-audit event (outside StoragePort — written by front tiers, PLAN 8.4). */
  logAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (actor, action, detail, at) VALUES (?, ?, ?, ?)`,
      )
      .run(event.actor, event.action, event.detail, event.at);
  }

  /** Audit events in insertion order, optionally filtered to at >= since (for CLI audit --since). */
  listAudit(since?: string): AuditEvent[] {
    return (
      since === undefined
        ? this.db
            .prepare(
              `SELECT actor, action, detail, at FROM audit_log ORDER BY rowid`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT actor, action, detail, at FROM audit_log WHERE at >= ? ORDER BY rowid`,
            )
            .all(since)
    ) as AuditEvent[];
  }

  // --- API tokens (PLAN-V2 10.3) — Bearer auth for serve mode. Plaintext is never stored. ---

  /** Mint a token: random 32-byte secret, store salted sha256 hash + scopes. Returns the plaintext once. */
  createToken(spec: { name: string; scopes: string[]; created_at: string }): {
    token: string;
  } {
    const secret = `yk_${randomBytes(32).toString("hex")}`;
    const salt = randomBytes(16).toString("hex");
    this.db
      .prepare(
        `INSERT INTO tokens (name, salt, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        spec.name,
        salt,
        sha256(salt + secret),
        JSON.stringify(spec.scopes),
        spec.created_at,
      );
    return { token: secret };
  }

  /** Resolve a presented secret to its name+scopes, or null. Scans all rows (per-token salt) —
   * token counts are tiny, and the timing-safe compare avoids a hash-comparison side channel. */
  verifyToken(secret: string): { name: string; scopes: string[] } | null {
    const rows = this.db
      .prepare(`SELECT name, salt, hash, scopes FROM tokens`)
      .all() as { name: string; salt: string; hash: string; scopes: string }[];
    for (const r of rows) {
      const got = Buffer.from(sha256(r.salt + secret), "hex");
      const want = Buffer.from(r.hash, "hex");
      if (got.length === want.length && timingSafeEqual(got, want)) {
        return { name: r.name, scopes: JSON.parse(r.scopes) as string[] };
      }
    }
    return null;
  }

  /** Delete a token by name. Returns whether a row was removed. */
  revokeToken(name: string): boolean {
    return (
      this.db.prepare(`DELETE FROM tokens WHERE name = ?`).run(name).changes > 0
    );
  }

  /** All tokens, sans secret/hash (for `yoke token list`). */
  listTokens(): TokenInfo[] {
    return (
      this.db
        .prepare(
          `SELECT name, scopes, created_at FROM tokens ORDER BY created_at`,
        )
        .all() as { name: string; scopes: string; created_at: string }[]
    ).map((r) => ({
      name: r.name,
      scopes: JSON.parse(r.scopes) as string[],
      created_at: r.created_at,
    }));
  }

  // --- Durability (PLAN-V2 11.1): backup + PITR-lite export. ---

  /** Online backup to a fresh file (11.1). better-sqlite3's `.backup()` is WAL-safe and produces a
   * single consistent DB file — no need to checkpoint or stop writes first. */
  async backupTo(dest: string): Promise<void> {
    await this.db.backup(dest);
  }

  /** PITR-lite (11.1): reconstruct DB state as of `ts` into a fresh file. History is append-only, so
   * we copy every entity/relation/ontology/audit row created at or before ts and rebuild FTS from the
   * surviving latest versions. Embeddings/vec are NOT carried over (search falls back to FTS on the
   * export). Precision caveat: created_at is the DB-default server clock (strftime '%Y-...Z','now'),
   * i.e. whole-second ingestion time — not the domain occurred_at. The cut is by ingestion time.
   * Columns are listed explicitly so a pre-10.1 source (ns appended last by migration) copies cleanly
   * into a fresh dest (ns mid-row). */
  async exportUntil(ts: string, destPath: string): Promise<void> {
    // Fresh dest with the full schema, then attach and row-copy with SQL (simplest — SPEC 11.1).
    const dst = new SqliteStorage(destPath);
    await dst.init();
    dst.close();
    this.db.prepare("ATTACH DATABASE ? AS bak").run(destPath);
    try {
      this.db
        .prepare(
          `INSERT INTO bak.entities (id, version, type, status, attributes, provenance, last_confirmed, ns, created_at)
           SELECT id, version, type, status, attributes, provenance, last_confirmed, ns, created_at
           FROM entities WHERE COALESCE(created_at, last_confirmed) <= ?`,
        )
        .run(ts);
      this.db
        .prepare(
          `INSERT INTO bak.relations (id, version, type, status, attributes, provenance, last_confirmed, ns, created_at, from_id, to_id)
           SELECT id, version, type, status, attributes, provenance, last_confirmed, ns, created_at, from_id, to_id
           FROM relations WHERE COALESCE(created_at, last_confirmed) <= ?`,
        )
        .run(ts);
      // Ontology defs have no timestamp — copy them all; a reconstructed DB is unusable without them.
      this.db.exec(
        `INSERT INTO bak.ontology_types (name, version, def, ns)
         SELECT name, version, def, ns FROM ontology_types`,
      );
      this.db
        .prepare(
          `INSERT INTO bak.audit_log (actor, action, detail, at)
           SELECT actor, action, detail, at FROM audit_log WHERE at <= ?`,
        )
        .run(ts);
      // Rebuild FTS from the copied latest versions (serializeText is JS, not SQL).
      const latest = this.db
        .prepare(
          `SELECT id, type, attributes FROM bak.entities e
           WHERE e.version = (SELECT MAX(version) FROM bak.entities WHERE id = e.id)`,
        )
        .all() as { id: string; type: string; attributes: string }[];
      const ins = this.db.prepare(
        `INSERT INTO bak.entities_fts (id, text) VALUES (?, ?)`,
      );
      for (const r of latest)
        ins.run(r.id, serializeText(r.type, r.attributes));
    } finally {
      this.db.exec("DETACH DATABASE bak");
    }
  }

  /** Latest version per name, in first-registration order, within one namespace scope. */
  private loadOntologyScope(ns: string | null): TypeDef[] {
    const rows = this.db
      .prepare(
        `SELECT def FROM ontology_types t
         WHERE t.ns IS @ns
           AND t.version = (SELECT MAX(version) FROM ontology_types WHERE name = t.name AND ns IS @ns)
         ORDER BY (SELECT MIN(rowid) FROM ontology_types WHERE name = t.name AND ns IS @ns)`,
      )
      .all({ ns }) as { def: string }[];
    return rows.map((r) => JSON.parse(r.def) as TypeDef);
  }

  /** Load the effective ontology for a namespace (PLAN-V2 10.1): tenant defs overlaid on the
   * shared (null-ns) base by name. Omitted ns = the shared base alone (backward compatible). */
  loadOntology(ns?: string | null): TypeDef[] {
    const shared = this.loadOntologyScope(null);
    const n = normalizeNs(ns);
    if (n === null) return shared;
    // Overlay: shared order preserved, tenant defs replace same-name entries in place, tenant-only
    // types appended (Map keeps insertion order; re-set keeps the original slot).
    const byName = new Map(shared.map((d) => [d.name, d]));
    for (const d of this.loadOntologyScope(n)) byName.set(d.name, d);
    return [...byName.values()];
  }
}
