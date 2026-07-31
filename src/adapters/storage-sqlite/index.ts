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
import {
  type ListQuery,
  type Page,
  page,
  type StoragePort,
  type TextQuery,
} from "../../ports/storage.js";

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
  at TEXT NOT NULL,                  -- ISO 8601
  ns TEXT                            -- tenant namespace; NULL = default shared ns
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
  /** Tenant namespace the read/action happened in. Omitted = the default shared namespace.
   * Without it an audit viewer would show every tenant's queries to every tenant. */
  ns?: string | null;
}

/** listAudit filter. Most-recent-N window: `limit` takes the newest rows, returned oldest-first. */
export interface AuditQuery {
  since?: string;
  ns?: string | null;
  limit?: number;
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
    // audit_log joined the list in v5.0 (its rows were namespace-blind until then).
    for (const table of [
      "entities",
      "relations",
      "ontology_types",
      "audit_log",
    ]) {
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
    // AND-of-prefix-tokens: every query term must appear (any order), each with
    // prefix tolerance — so "Slack retry" finds "Slack connector retries", and a
    // token carrying a trailing particle/suffix (common in agglutinative languages
    // like Korean) is still found by its stem. Each token is quoted (special chars
    // are safe) and starred. This also matches the kuzu/qdrant adapters' semantics —
    // the original whole-query phrase match required consecutive terms, which made
    // multi-word queries silently miss (found in live MCP verification).
    const tokens = q.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
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

  /** Enumerate latest-version entities, ascending by id (ULID order = creation order).
   * Over-reads one row so `next` is non-null only when rows actually remain — see Page. */
  async listEntities(q: ListQuery): Promise<Page<Entity>> {
    return page(
      this.listPage<EntityRow>("entities", "e", q).map(rowToEntity),
      q.limit,
    );
  }

  /** Enumerate latest-version relations, ascending by id. q.type filters the relation type. */
  async listRelations(q: ListQuery): Promise<Page<Relation>> {
    return page(
      this.listPage<RelationRow>("relations", "r", q).map(rowToRelation),
      q.limit,
    );
  }

  /** Shared enumeration SQL. Both tables carry the same (id, version, type, status, ns) shape, so
   * the only difference is the table name — keeping one query keeps the two contracts identical. */
  private listPage<R>(
    table: "entities" | "relations",
    alias: string,
    q: ListQuery,
  ): R[] {
    const a = alias;
    const typeClause = q.type === undefined ? "" : ` AND ${a}.type = @type`;
    const statusClause =
      q.status === undefined ? "" : ` AND ${a}.status = @status`;
    const afterClause = q.after === undefined ? "" : ` AND ${a}.id > @after`;
    // limit + 1: the extra row is the evidence that a next page exists (never returned).
    const limitClause = q.limit === undefined ? "" : " LIMIT @limit";
    return this.db
      .prepare(
        `SELECT ${a}.* FROM ${table} ${a}
         WHERE ${a}.version = (SELECT MAX(version) FROM ${table} WHERE id = ${a}.id)
           AND ${a}.ns IS @ns${typeClause}${statusClause}${afterClause}
         ORDER BY ${a}.id${limitClause}`,
      )
      .all({
        ns: normalizeNs(q.ns),
        type: q.type,
        status: q.status,
        after: q.after,
        limit: q.limit === undefined ? undefined : q.limit + 1,
      }) as R[];
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

  /**
   * Rename an ontology type everywhere it is stored: the declaration, every entity and relation
   * version carrying it, and the FTS text (which embeds the type name — see serializeText).
   *
   * This REWRITES existing rows instead of appending, and that is the point. Appending a new version
   * per record would leave the old name in every historical row, and a rename exists precisely so the
   * old name is gone. Nothing about the knowledge changes — same ids, same version numbers, same
   * attributes, provenance and edges — so no version is invented and no promotion is implied; only a
   * vocabulary term moves. The append-only rule protects what was asserted, not what it was called.
   *
   * The schema comment above says entity mutations need no audit row because the version history
   * records them. This is the one mutation it CANNOT record, so the caller writes the row that does —
   * see `yoke rename-type`. Returns rows rewritten (declaration included) so it can be reported.
   */
  renameType(from: string, to: string, ns?: string | null): number {
    const n = normalizeNs(ns);
    return this.db.transaction(() => {
      let rows = 0;
      // Collected before the UPDATE: the FTS text is built from type + attributes, so every affected
      // id's index row goes stale the instant the column changes.
      const ids = (
        this.db
          .prepare(
            `SELECT DISTINCT id FROM entities WHERE type = ? AND ns IS ?`,
          )
          .all(from, n) as { id: string }[]
      ).map((r) => r.id);
      rows += this.db
        .prepare(`UPDATE entities SET type = ? WHERE type = ? AND ns IS ?`)
        .run(to, from, n).changes;
      // Relations too, without asking the caller which kind it was: one name lives in one ontology,
      // and `kind` only decides which table holds it. The other statement simply matches nothing.
      rows += this.db
        .prepare(`UPDATE relations SET type = ? WHERE type = ? AND ns IS ?`)
        .run(to, from, n).changes;
      const del = this.db.prepare(`DELETE FROM entities_fts WHERE id = ?`);
      const ins = this.db.prepare(
        `INSERT INTO entities_fts (id, text) VALUES (?, ?)`,
      );
      const latest = this.db.prepare(
        `SELECT type, attributes FROM entities WHERE id = ? ORDER BY version DESC LIMIT 1`,
      );
      for (const id of ids) {
        const l = latest.get(id) as { type: string; attributes: string };
        del.run(id);
        ins.run(id, serializeText(l.type, l.attributes));
      }
      // The declaration. saveOntology appends a version per name, which would leave every `from` row
      // sitting there, so these are rewritten in place — name column and the name inside `def`.
      const declared = this.db
        .prepare(
          `SELECT 1 FROM ontology_types WHERE name = ? AND ns IS ? LIMIT 1`,
        )
        .get(to, n);
      if (declared) {
        // `to` already exists — the ordinary case when the code was renamed before the database was,
        // so a later `yoke init` seeded the new type beside the old one. Drop the stale declaration
        // rather than colliding with the live one; the rows above already point at the survivor.
        rows += this.db
          .prepare(`DELETE FROM ontology_types WHERE name = ? AND ns IS ?`)
          .run(from, n).changes;
      } else {
        const defs = this.db
          .prepare(
            `SELECT version, def FROM ontology_types WHERE name = ? AND ns IS ?`,
          )
          .all(from, n) as { version: number; def: string }[];
        const upd = this.db.prepare(
          `UPDATE ontology_types SET name = ?, def = ? WHERE name = ? AND version = ? AND ns IS ?`,
        );
        for (const r of defs) {
          const def: TypeDef = { ...(JSON.parse(r.def) as TypeDef), name: to };
          rows += upd.run(to, JSON.stringify(def), from, r.version, n).changes;
        }
      }
      return rows;
    })();
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
        `INSERT INTO audit_log (actor, action, detail, at, ns) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.actor,
        event.action,
        event.detail,
        event.at,
        normalizeNs(event.ns),
      );
  }

  /** Audit events in insertion order (oldest first), filtered by ns and optionally at >= since.
   * `limit` takes the most recent N and still returns them oldest-first, so a paging viewer and
   * `yoke audit` read the same direction. */
  listAudit(q: AuditQuery = {}): AuditEvent[] {
    const sinceClause = q.since === undefined ? "" : " AND at >= @since";
    // DESC + LIMIT selects the newest rows; the reverse below restores ascending order.
    const order = q.limit === undefined ? "rowid" : "rowid DESC";
    const limitClause = q.limit === undefined ? "" : " LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT actor, action, detail, at, ns FROM audit_log
         WHERE ns IS @ns${sinceClause}
         ORDER BY ${order}${limitClause}`,
      )
      .all({
        ns: normalizeNs(q.ns),
        since: q.since,
        limit: q.limit,
      }) as AuditEvent[];
    // Default ns leaves the field absent, matching how entity rows carry ns (opaque parity).
    for (const r of rows) if (r.ns == null) delete r.ns;
    return q.limit === undefined ? rows : rows.reverse();
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
