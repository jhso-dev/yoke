// storage-postgres — the PostgreSQL implementation of StoragePort (+ the composite's `RemoteStore`).
//
// The third remote backend, and the one people already run. Where neo4j needed a graph and opensearch
// needed a cluster, this asks for the database every company already has a DBA for — which is the
// entire argument for it. It costs one dependency (`pg`, ~1 MB) and no new operational surface.
//
// Native BM25-ish ranking via `ts_rank`, native k-NN via pgvector, no native traversal: `neighbors` is
// an index lookup on from_id/to_id, the same shape as sqlite and opensearch (docs/BACKENDS.md
// capability matrix).
//
// Six decisions here are contract rather than implementation. Each was checked against a real 17
// server before it was written:
//
//  1. **Everything lives in ONE schema, named by the caller.** `new PostgresStorage({ url, schema })`
//     defaults to `yoke` and `init()` creates it. Postgres has no "database per directory" the way
//     sqlite has a file, so the schema is the unit of separation: two yoke stores share a database
//     without a second server, and the test suite gets a throwaway namespace per conformance case
//     instead of a shared table it has to clean up correctly.
//  2. **The searchable text is a `tsvector` column that exists ONLY on the latest version row.** A new
//     version nulls the superseded row's `tsv`. This is the same policy as sqlite's FTS delete+insert
//     and opensearch's `latest` flag, and it does two jobs at once: a query can never match text a
//     record no longer says, and `tsv IS NOT NULL` *is* the latest-version predicate for search, so no
//     `MAX(version)` subquery runs on the hot path. The reconcile is written as a single
//     order-independent UPDATE (see `reconcileSearchable`) rather than "null everything below me",
//     because putting v1 after v2 would otherwise leave two rows searchable for one id.
//  3. **The query is a `tsquery` CAST, not `to_tsquery`.** `to_tsquery` runs the input back through the
//     parser, and the parser is entitled to split one input token into several lexemes — at which point
//     it raises `syntax error in tsquery`, on user text, at query time. Casting `'lexeme':*` skips
//     parsing and dictionary normalization entirely. That is safe *because* core's `tokenize` already
//     produced the lexemes: it lowercases and splits on non-letter/number runs, which is exactly what
//     the `simple` dictionary would have done to each token.
//  4. **`simple`, not `english`.** A stemming configuration is a language commitment, and this store
//     holds Korean. Measured: `to_tsvector('simple', ...)` lexes `parseArgs로` as ONE token, so the
//     prefix term `'parseargs':*` reaches it — conformance case 6b. Under `english` the same text is
//     stemmed unpredictably and the stopword list silently deletes query terms. `simple` has no
//     stopwords, so `and`/`the` stay searchable, which matters when the corpus is JSON attribute keys.
//  5. **Prefix terms both match AND score.** Unlike Lucene, a Postgres prefix term is not
//     constant-score: `ts_rank` counts the positions a prefix term hit, so the record that is *about*
//     a term outranks the one that mentions it once (measured: 0.0760 vs 0.0608 on conformance case
//     6d's fixtures). No second "exact" clause is needed here, which is the one place this adapter is
//     simpler than the opensearch one.
//  6. **Vectors live in their own table keyed by entity id, and pgvector is OPTIONAL.** `init()` tries
//     `CREATE EXTENSION IF NOT EXISTS vector` and then *verifies the type exists*; without it,
//     `similar` and `putEmbedding` are genuinely absent from the instance (they are assigned in
//     `init()`, not declared as methods), so `typeof store.similar === "function"` tells the truth and
//     core falls back to keyword retrieval. A managed Postgres that has not enabled the extension is a
//     working yoke store, not a startup failure.
//
// ns is stored as `''` for the default shared namespace, matching neo4j and opensearch. sqlite uses
// SQL NULL and `IS` comparisons; here a NOT NULL column with a sentinel keeps every predicate a plain
// `=` (and therefore index-usable) and keeps one rule across the three remote adapters.

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { dimensionMismatch, serializeText } from "../../core/embedding.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { requireEveryTerm, tokenize } from "../../core/rank.js";
import type { Entity, Provenance, Relation, Status } from "../../core/types.js";
import {
  DEFAULT_SEARCH_LIMIT,
  type ListQuery,
  orderByIds,
  type Page,
  page,
  type StoragePort,
  type TextQuery,
} from "../../ports/storage.js";

/** The text-search configuration. See decision 4 in the header — this is a contract, not a knob. */
const REGCONFIG = "simple";

/** Columns of a stored row, in the order every read selects them. `txt`/`tsv` are index state, never
 * returned: they are derived from `type` + `attributes` and a caller has both. */
const ENTITY_COLS =
  "id, version, type, status, ns, attributes, provenance, last_confirmed";
const RELATION_COLS = `${ENTITY_COLS}, from_id, to_id`;

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  ns: string;
  attributes: Record<string, unknown>;
  provenance: Provenance;
  last_confirmed: string;
}
interface RelationRow extends EntityRow {
  from_id: string;
  to_id: string;
}

function toEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    type: r.type,
    version: r.version,
    status: r.status as Status,
    attributes: r.attributes,
    provenance: r.provenance,
    last_confirmed: r.last_confirmed,
    ...(r.ns ? { ns: r.ns } : {}),
  };
}

function toRelation(r: RelationRow): Relation {
  return { ...toEntity(r), from: r.from_id, to: r.to_id };
}

/** pgvector's text form: `[1,2,3]`. Used for writes and for reading a stored vector back. */
function toVectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}
function fromVectorLiteral(s: string): Float32Array {
  return Float32Array.from(
    s
      .slice(1, -1)
      .split(",")
      .map((n) => Number(n)),
  );
}

export interface PostgresOptions {
  /** Standard DSN: `postgres://user:pass@host:port/db`. */
  url: string;
  /** Schema holding every table. Created by `init()`. Default `yoke` — see decision 1. */
  schema?: string;
  /** Pool size. The CLI opens and closes per command, so the default is deliberately small. */
  poolSize?: number;
}

export class PostgresStorage implements StoragePort {
  private readonly pool: Pool;
  /** Unquoted, for catalog lookups (`pg_namespace.nspname`). */
  private readonly schemaName: string;
  /** Quoted, for interpolation into SQL. */
  private readonly schema: string;
  /** Declared width of the vector table, or null when no vector has ever been written. */
  private vectorDim: number | null = null;
  /** Whether pgvector is usable. Set by `init()`; gates the two optional capabilities below. */
  private vectors = false;

  /**
   * The two optional capabilities, as PROPERTIES rather than methods (SPEC "The vector index").
   *
   * A method on the prototype is always present, and `similar` being present-but-throwing is the
   * failure mode core cannot see: `commit` and the hybrid retriever both branch on
   * `typeof port.similar === "function"` and would take the vector path into a hard error. `init()`
   * assigns these only after it has proved pgvector works, so absence is honest.
   *
   * `declare` is load-bearing, not decoration. Under `target: ES2022` TypeScript emits class fields
   * with `useDefineForClassFields`, so a plain `similar?: …` declaration DEFINES the property as
   * `undefined` — and `"similar" in store` then answers true on a server with no pgvector. `declare`
   * is type-only and emits nothing, so the key exists only once `init()` puts it there. The same
   * distinction the conformance suite relies on when it asserts with `in` rather than `typeof`.
   */
  declare similar?: (embedding: Float32Array, k: number) => Promise<Entity[]>;
  declare putEmbedding?: (
    e: Entity,
    opts?: { rebuild?: boolean },
  ) => Promise<void>;

  constructor(opts: PostgresOptions) {
    const name = opts.schema ?? "yoke";
    // Validated rather than escaped: the schema name is interpolated into every statement (a schema
    // cannot be a bind parameter), so the only safe version of this is a whitelist at the boundary.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `postgres schema name must be a plain identifier, got ${JSON.stringify(name)}`,
      );
    }
    this.schemaName = name;
    this.schema = `"${name}"`;
    this.pool = new Pool({
      connectionString: opts.url,
      max: opts.poolSize ?? 4,
    });
  }

  /** Schema-qualified table reference. */
  private t(table: string): string {
    return `${this.schema}."${table}"`;
  }

  private async q<R extends QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<R[]> {
    const res = await this.pool.query<R>(sql, params);
    return res.rows;
  }

  /**
   * Run `fn` on one pooled connection inside a transaction.
   *
   * Needed for exactly the writes that are two statements — a row plus the search-index reconcile, and
   * the ontology's read-max-then-append. On a pool those would otherwise land on different connections
   * and a concurrent reader could see the gap.
   */
  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async init(): Promise<void> {
    // Idempotent throughout, the way sqlite's CREATE TABLE IF NOT EXISTS block is: `init()` is also
    // the upgrade path for a schema that already holds rows.
    await this.q(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.q(`CREATE TABLE IF NOT EXISTS ${this.t("entities")} (
      id             TEXT    NOT NULL,
      version        INTEGER NOT NULL,
      type           TEXT    NOT NULL,
      status         TEXT    NOT NULL,
      ns             TEXT    NOT NULL DEFAULT '',
      attributes     JSONB   NOT NULL,
      provenance     JSONB   NOT NULL,
      last_confirmed TEXT    NOT NULL,
      -- The exact serializeText() output, kept so the tsvector can be rebuilt (renameType) without
      -- re-deriving the caller's JSON. Not returned by any read.
      txt            TEXT    NOT NULL,
      -- Non-null on the latest version only. See decision 2.
      tsv            TSVECTOR,
      PRIMARY KEY (id, version)
    )`);
    await this.q(`CREATE TABLE IF NOT EXISTS ${this.t("relations")} (
      id             TEXT    NOT NULL,
      version        INTEGER NOT NULL,
      type           TEXT    NOT NULL,
      status         TEXT    NOT NULL,
      ns             TEXT    NOT NULL DEFAULT '',
      attributes     JSONB   NOT NULL,
      provenance     JSONB   NOT NULL,
      last_confirmed TEXT    NOT NULL,
      from_id        TEXT    NOT NULL,
      to_id          TEXT    NOT NULL,
      PRIMARY KEY (id, version)
    )`);
    // Append-only per (name, ns): saveOntology adds the next version, loadOntology reads the max.
    // `seq` preserves declaration order across versions, which is what the tenant overlay needs — the
    // same job sqlite does with MIN(rowid).
    await this.q(`CREATE TABLE IF NOT EXISTS ${this.t("ontology_types")} (
      name    TEXT    NOT NULL,
      ns      TEXT    NOT NULL DEFAULT '',
      version INTEGER NOT NULL,
      def     JSONB   NOT NULL,
      seq     BIGSERIAL,
      PRIMARY KEY (name, ns, version)
    )`);

    // Indexes chosen from the same measurements as sqlite's (docs/SCALE.md): ns leads the composites
    // because every enumeration is namespace-scoped, from_id/to_id are SEPARATE single-column indexes
    // because neighbors asks `from_id = ? OR to_id = ?` and a composite would never be used, and the
    // GIN index is what makes search an index scan instead of recomputing ts_rank over the table.
    for (const ddl of [
      `CREATE INDEX IF NOT EXISTS entities_ns_type_id ON ${this.t("entities")} (ns, type, id)`,
      `CREATE INDEX IF NOT EXISTS entities_ns_status_id ON ${this.t("entities")} (ns, status, id)`,
      `CREATE INDEX IF NOT EXISTS entities_tsv ON ${this.t("entities")} USING GIN (tsv)`,
      `CREATE INDEX IF NOT EXISTS relations_ns_type_id ON ${this.t("relations")} (ns, type, id)`,
      `CREATE INDEX IF NOT EXISTS relations_from ON ${this.t("relations")} (from_id)`,
      `CREATE INDEX IF NOT EXISTS relations_to ON ${this.t("relations")} (to_id)`,
    ]) {
      await this.q(ddl);
    }

    this.vectors = await this.detectVectors();
    if (this.vectors) {
      this.similar = (embedding, k) => this.nearest(embedding, k);
      this.putEmbedding = (e, opts) => this.indexVector(e, opts);
    }
    // The vector TABLE is created lazily, not here: its column declares the dimension, which is not
    // known until the first vector arrives. Same lazy shape as sqlite's vec0 table.
  }

  /**
   * Is pgvector usable? Tried, then VERIFIED — `CREATE EXTENSION` failing is the obvious signal
   * (no control file, or no privilege on a managed instance), but a successful call on a server where
   * the type is somehow unreachable would still leave `similar` broken, and the point of this probe is
   * that absence is honest. Run outside a transaction on purpose: the failure aborts its transaction,
   * so batching it with the DDL above would poison the whole `init()`.
   */
  private async detectVectors(): Promise<boolean> {
    await this.q("CREATE EXTENSION IF NOT EXISTS vector").catch(() => {});
    const rows = await this.q<{ ok: number }>(
      "SELECT 1 AS ok FROM pg_type WHERE typname = 'vector' LIMIT 1",
    );
    return rows.length > 0;
  }

  close(): void {
    // Fire-and-forget: the port's close() is synchronous (it was shaped by better-sqlite3), and a
    // pool teardown is a network round trip. Nothing reads the store after close, so the only thing
    // awaiting would buy is a tidier shutdown log.
    void this.pool.end();
  }

  // --- writes ---------------------------------------------------------------------------------

  async putEntity(e: Entity): Promise<void> {
    const txt = serializeText(e.type, JSON.stringify(e.attributes));
    // Plain INSERT, not an upsert: re-putting an existing (id, version) is a primary-key conflict and
    // must stay one. That conflict is precisely why `putEmbedding` exists as a separate method (SPEC
    // "The vector index"), so swallowing it here would remove the reason for the design.
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO ${this.t("entities")}
           (id, version, type, status, ns, attributes, provenance, last_confirmed, txt)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          e.id,
          e.version,
          e.type,
          e.status,
          normalizeNs(e.ns) ?? "",
          JSON.stringify(e.attributes),
          JSON.stringify(e.provenance),
          e.last_confirmed,
          txt,
        ],
      );
      await this.reconcileSearchable(c, e.id);
    });
    if (e.embedding && this.vectors) await this.writeVector(e.id, e.embedding);
  }

  /**
   * Make exactly the max-version row of `id` searchable and no other (decision 2).
   *
   * Written as "compute which row *should* carry the tsvector" rather than "null everything below the
   * row I just wrote", so it is correct whatever order the versions arrive in — putting v1 after v2
   * would otherwise leave two searchable rows for one id and a query would return both. The final
   * predicate limits the write to rows whose state is actually wrong, which is one or two rows.
   */
  private async reconcileSearchable(c: PoolClient, id: string): Promise<void> {
    await c.query(
      `UPDATE ${this.t("entities")} e
          SET tsv = CASE WHEN e.version = m.mx
                         THEN to_tsvector('${REGCONFIG}', e.txt) ELSE NULL END
         FROM (SELECT MAX(version) AS mx FROM ${this.t("entities")} WHERE id = $1) m
        WHERE e.id = $1
          AND ((e.version = m.mx AND e.tsv IS NULL)
            OR (e.version <> m.mx AND e.tsv IS NOT NULL))`,
      [id],
    );
  }

  /** One edge by id — parity with sqlite's, so `get <relation-id>` behaves the same on both. */
  async getRelation(id: string, version?: number): Promise<Relation | null> {
    const rows =
      version === undefined
        ? await this.q<RelationRow>(
            `SELECT ${RELATION_COLS} FROM ${this.t("relations")}
              WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
          )
        : await this.q<RelationRow>(
            `SELECT ${RELATION_COLS} FROM ${this.t("relations")}
              WHERE id = $1 AND version = $2`,
            [id, version],
          );
    return rows[0] ? toRelation(rows[0]) : null;
  }

  async putRelation(r: Relation): Promise<void> {
    // One statement: relations are not searchable (there is no FTS index over edges on any backend),
    // so there is no derived index to reconcile.
    await this.q(
      `INSERT INTO ${this.t("relations")}
         (id, version, type, status, ns, attributes, provenance, last_confirmed, from_id, to_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
      [
        r.id,
        r.version,
        r.type,
        r.status,
        normalizeNs(r.ns) ?? "",
        JSON.stringify(r.attributes),
        JSON.stringify(r.provenance),
        r.last_confirmed,
        r.from,
        r.to,
      ],
    );
  }

  // --- vectors --------------------------------------------------------------------------------

  /**
   * The declared width of the vector table, or null when it does not exist yet.
   *
   * `atttypmod` IS the dimension for a pgvector column (verified: `vector(4)` → 4), unlike the
   * length-plus-header convention `varchar` uses. Read from the catalog rather than remembered in
   * process, because a second client may have created the table.
   */
  private async vecDim(): Promise<number | null> {
    if (this.vectorDim !== null) return this.vectorDim;
    const rows = await this.q<{ dim: number }>(
      `SELECT a.atttypmod AS dim
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'entity_vec' AND a.attname = 'embedding'`,
      [this.schemaName],
    );
    this.vectorDim = rows[0]?.dim ?? null;
    return this.vectorDim;
  }

  private async ensureVecTable(dim: number, rebuild: boolean): Promise<void> {
    if (rebuild) {
      // The only way to change dimension: the column type carries the width, so a rebuild is a new
      // table rather than an ALTER. Callers pass `rebuild` on the FIRST row of a backfill and never
      // after, or each row would wipe the previous one.
      await this.q(`DROP TABLE IF EXISTS ${this.t("entity_vec")}`);
      this.vectorDim = null;
    }
    const current = await this.vecDim();
    if (current !== null) {
      if (current !== dim) throw dimensionMismatch(current, dim, false);
      return;
    }
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(
        `embedding dimension must be a positive integer, got ${dim}`,
      );
    }
    // No ANN index. At the scale a single Postgres serves, exact search over `<=>` is fast and
    // exactly right, whereas ivfflat needs a populated table to train on and hnsw costs build time
    // per row — both of which are the wrong trade for a store that is usually well under a million
    // vectors. ceiling: add `USING hnsw (embedding vector_cosine_ops)` when a measured corpus shows
    // similar() dominating query latency.
    await this.q(
      `CREATE TABLE IF NOT EXISTS ${this.t("entity_vec")} (
         id        TEXT NOT NULL PRIMARY KEY,
         embedding vector(${dim}) NOT NULL
       )`,
    );
    this.vectorDim = dim;
  }

  /** One row per entity id, so re-embedding replaces rather than accumulating — which is what makes
   * `yoke backfill --embeddings` idempotent, and what stops a k-NN hit appearing once per version. */
  private async writeVector(
    id: string,
    embedding: Float32Array,
    rebuild = false,
  ): Promise<void> {
    await this.ensureVecTable(embedding.length, rebuild);
    await this.q(
      `INSERT INTO ${this.t("entity_vec")} (id, embedding) VALUES ($1, $2::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [id, toVectorLiteral(embedding)],
    );
  }

  /** Body of the optional `putEmbedding`, assigned in `init()` only when pgvector is present. */
  private async indexVector(
    e: Entity,
    opts?: { rebuild?: boolean },
  ): Promise<void> {
    if (!e.embedding) return;
    await this.writeVector(e.id, e.embedding, opts?.rebuild ?? false);
  }

  /** Body of the optional `similar`, assigned in `init()` only when pgvector is present. */
  private async nearest(embedding: Float32Array, k: number): Promise<Entity[]> {
    const dim = await this.vecDim();
    // No table means no vector was ever written — an empty index, not an error.
    if (dim === null) return [];
    // Reads get the same dimension check as writes: without it a model change would answer out of the
    // OLD vector space, which is a plausible-looking neighbour list that is confidently wrong.
    if (dim !== embedding.length) {
      throw dimensionMismatch(dim, embedding.length, true);
    }
    const hits = await this.q<{ id: string; embedding: string }>(
      `SELECT id, embedding::text AS embedding FROM ${this.t("entity_vec")}
        ORDER BY embedding <=> $1::vector LIMIT $2`,
      [toVectorLiteral(embedding), k],
    );
    // ONE batch read in distance order, not one per hit: `similar` runs on every hybrid query with
    // k = limit x 3, the largest N+1 on the read paths (v5.5). getEntities preserves the id order it
    // is handed, which is what keeps distance order intact.
    const vectors = new Map(hits.map((h) => [h.id, h.embedding] as const));
    const rows = await this.getEntities([...vectors.keys()]);
    // The vector is restored onto the row, like sqlite does. `commit`'s duplicate detection filters on
    // `c.embedding !== undefined` and computes cosine itself, so an adapter that drops it silently
    // turns duplicate detection into a no-op that still reports "embedding".
    return rows.map((e) => {
      const raw = vectors.get(e.id);
      return raw === undefined
        ? e
        : { ...e, embedding: fromVectorLiteral(raw) };
    });
  }

  // --- point reads ----------------------------------------------------------------------------

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const rows =
      version === undefined
        ? await this.q<EntityRow>(
            `SELECT ${ENTITY_COLS} FROM ${this.t("entities")}
              WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
          )
        : await this.q<EntityRow>(
            `SELECT ${ENTITY_COLS} FROM ${this.t("entities")}
              WHERE id = $1 AND version = $2`,
            [id, version],
          );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  /** Batch point read (v5.5) — the point-read loop as ONE round trip, which is the whole reason a
   * remote adapter implements the optional method at all. `= ANY($1)` rather than a built IN list, so
   * the statement text is constant and Postgres can reuse the plan across call sites. */
  async getEntities(ids: string[]): Promise<Entity[]> {
    // Empty in, empty out — and NOT `IN ()`, which is a syntax error, nor an unguarded scan.
    if (ids.length === 0) return [];
    const rows = await this.q<EntityRow>(
      `SELECT ${ENTITY_COLS} FROM ${this.t("entities")} e
        WHERE e.id = ANY($1::text[])
          AND e.version = (SELECT MAX(version) FROM ${this.t("entities")} WHERE id = e.id)`,
      [ids],
    );
    return orderByIds(rows.map(toEntity), ids);
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    // The direction is a closed set of three, so it is branched in JS rather than expressed as a
    // parameterized OR: each branch is a predicate the from_id/to_id indexes can actually serve.
    const ends =
      dir === "out"
        ? "r.from_id = $1"
        : dir === "in"
          ? "r.to_id = $1"
          : "(r.from_id = $1 OR r.to_id = $1)";
    // Namespace-unscoped, like sqlite and opensearch: an edge is reached from an id, and ids are
    // globally unique ULIDs, so there is no namespace question to answer here.
    const rows = await this.q<RelationRow>(
      `SELECT ${RELATION_COLS} FROM ${this.t("relations")} r
        WHERE ${ends}
          AND ($2::text IS NULL OR r.type = $2)
          AND r.version = (SELECT MAX(version) FROM ${this.t("relations")} WHERE id = r.id)
        ORDER BY r.id`,
      [id, relType ?? null],
    );
    return rows.map(toRelation);
  }

  // --- search ---------------------------------------------------------------------------------

  /**
   * Keyword search, native end to end: a `tsquery` of prefix terms against the GIN-indexed `tsvector`,
   * ranked by `ts_rank`. No app-level fallback — every clause of SPEC "search" is expressible here.
   *
   * - clause 8 (long queries are a disjunction) is `&` vs `|`, decided by core's `requireEveryTerm` so
   *   the threshold lives in one place.
   * - clause 9 (a query term matches any token it prefixes) is the `:*` on every lexeme.
   * - clause 6 (best match first) is `ts_rank` DESC with an `id` tiebreak, so two equally relevant
   *   records order identically on every backend.
   * - filters run BEFORE the limit, because they are predicates in the same statement as the LIMIT.
   */
  async search(q: TextQuery): Promise<Entity[]> {
    const tokens = tokenize(q.text);
    if (tokens.length === 0) return [];
    const op = requireEveryTerm(tokens.length, q.terms) ? " & " : " | ";
    // Quoted lexemes, cast rather than parsed — decision 3. The escape is belt-and-braces: `tokenize`
    // strips everything that is not a letter or a number, so a quote cannot reach here.
    const tsquery = tokens.map((t) => `'${t.replace(/'/g, "''")}':*`).join(op);
    // A single status and an array are both required to work (SPEC), so a single one is widened into
    // a one-element array and ONE predicate serves both.
    const status =
      q.status === undefined
        ? null
        : Array.isArray(q.status)
          ? q.status
          : [q.status];
    const rows = await this.q<EntityRow>(
      // `tsv @@ ...` also carries the latest-version filter: only the latest row has a tsvector at
      // all (decision 2), so no MAX(version) subquery is needed on the search path.
      `SELECT ${ENTITY_COLS} FROM ${this.t("entities")}
        WHERE tsv @@ $1::tsquery
          AND ns = $2
          AND ($3::text IS NULL OR type = $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
        ORDER BY ts_rank(tsv, $1::tsquery) DESC, id ASC
        LIMIT $5`,
      [
        tsquery,
        normalizeNs(q.ns) ?? "",
        q.type ?? null,
        status,
        // Bounded even when the caller forgets (clause 7): at 10M entities the unbounded call
        // materialized ten million row objects and the process died (docs/SCALE.md).
        q.limit ?? DEFAULT_SEARCH_LIMIT,
      ],
    );
    return rows.map(toEntity);
  }

  // --- enumeration ----------------------------------------------------------------------------

  /**
   * Shared enumeration SQL. Both tables carry the same (id, version, type, status, ns) shape, so one
   * query keeps the two contracts identical — the same reason sqlite has one `listPage`.
   *
   * `limit + 1` is over-read so `next` reflects a row that EXISTS rather than the guess
   * `items.length === limit`; `page()` in the port turns that into the cursor. `LIMIT NULL` is
   * Postgres for "no limit", which is how the omitted-limit case stays unbounded without a second
   * statement string.
   */
  private async listPage<R extends QueryResultRow>(
    table: "entities" | "relations",
    cols: string,
    q: ListQuery,
  ): Promise<R[]> {
    return this.q<R>(
      `SELECT ${cols} FROM ${this.t(table)} t
        WHERE t.version = (SELECT MAX(version) FROM ${this.t(table)} WHERE id = t.id)
          AND t.ns = $1
          AND ($2::text IS NULL OR t.type = $2)
          AND ($3::text IS NULL OR t.status = $3)
          AND ($4::text IS NULL OR t.id > $4)
        ORDER BY t.id
        LIMIT $5::bigint`,
      [
        // Omitted ns is the DEFAULT namespace only, never a wildcard over tenants: a listing that
        // defaults to every tenant is a leak by construction.
        normalizeNs(q.ns) ?? "",
        q.type ?? null,
        q.status ?? null,
        q.after ?? null,
        q.limit === undefined ? null : q.limit + 1,
      ],
    );
  }

  async listEntities(q: ListQuery): Promise<Page<Entity>> {
    const rows = await this.listPage<EntityRow>("entities", ENTITY_COLS, q);
    return page(rows.map(toEntity), q.limit);
  }

  async listRelations(q: ListQuery): Promise<Page<Relation>> {
    const rows = await this.listPage<RelationRow>(
      "relations",
      RELATION_COLS,
      q,
    );
    return page(rows.map(toRelation), q.limit);
  }

  // --- ontology (the async half of storage-composite's RemoteStore) ----------------------------

  /** Append-only save: accumulates as the next version per (name, ns), matching sqlite's
   * accumulate-don't-overwrite. One transaction, so a partial ontology is never visible. */
  async saveOntology(defs: TypeDef[], ns?: string | null): Promise<void> {
    const scope = normalizeNs(ns) ?? "";
    await this.tx(async (c) => {
      for (const def of defs) {
        // Read-max-and-insert in ONE statement: the aggregate over an empty set still returns a row,
        // so COALESCE(...) + 1 is 1 for a name that has never been declared.
        await c.query(
          `INSERT INTO ${this.t("ontology_types")} (name, ns, version, def)
           SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3::jsonb
             FROM ${this.t("ontology_types")} WHERE name = $1 AND ns = $2`,
          [def.name, scope, JSON.stringify(def)],
        );
      }
    });
  }

  /** Latest def per name within one namespace, in DECLARATION order (`MIN(seq)`) — the order matters
   * because the tenant overlay below preserves the shared base's ordering. */
  private async ontologyScope(scope: string): Promise<TypeDef[]> {
    const rows = await this.q<{ def: TypeDef }>(
      `SELECT t.def FROM ${this.t("ontology_types")} t
        WHERE t.ns = $1
          AND t.version = (SELECT MAX(version) FROM ${this.t("ontology_types")}
                            WHERE name = t.name AND ns = $1)
        ORDER BY (SELECT MIN(seq) FROM ${this.t("ontology_types")}
                   WHERE name = t.name AND ns = $1)`,
      [scope],
    );
    return rows.map((r) => r.def);
  }

  /** The effective ontology for a namespace (PLAN-V2 10.1): tenant defs overlaid on the shared base
   * by name. Shared order is preserved and a tenant def replaces its same-name entry IN PLACE (a Map
   * keeps insertion order and a re-set keeps the original slot); tenant-only types append. */
  async loadOntology(ns?: string | null): Promise<TypeDef[]> {
    const shared = await this.ontologyScope("");
    const scope = normalizeNs(ns);
    if (scope === null) return shared;
    const byName = new Map(shared.map((d) => [d.name, d]));
    for (const d of await this.ontologyScope(scope)) byName.set(d.name, d);
    return [...byName.values()];
  }

  /**
   * Rename an ontology type everywhere it is stored: the declaration, every entity and relation
   * version carrying it, and the searchable text (which embeds the type name — see `serializeText`).
   *
   * This REWRITES rather than appending, and that is the point: appending a version per record would
   * leave the old name in every historical row, and a rename exists precisely so the old name is gone.
   * Nothing about the knowledge changes — same ids, versions, attributes, provenance and edges — so no
   * promotion is implied. The append-only rule protects what was asserted, not what it was called.
   *
   * Returns rows rewritten, declaration included, so `yoke rename-type` can report it.
   */
  async renameType(
    from: string,
    to: string,
    ns?: string | null,
  ): Promise<number> {
    const scope = normalizeNs(ns) ?? "";
    return this.tx(async (c) => {
      let rows = 0;
      // `txt` is rebuilt from the stored JSONB rather than string-patched. jsonb's text form is
      // canonical (sorted keys, one space after each colon) and therefore not byte-identical to the
      // JSON.stringify that wrote it — which does not matter, because `txt` exists only to be
      // tokenized and both forms tokenize to the same lexemes. The tsvector is recomputed only where
      // one already lives, so the latest-version-only invariant survives the rename.
      const ents = await c.query(
        `UPDATE ${this.t("entities")}
            SET type = $1,
                txt = $1 || ' ' || attributes::text,
                tsv = CASE WHEN tsv IS NULL THEN NULL
                           ELSE to_tsvector('${REGCONFIG}', $1 || ' ' || attributes::text) END
          WHERE type = $2 AND ns = $3`,
        [to, from, scope],
      );
      rows += ents.rowCount ?? 0;
      // Relations too, without asking the caller which kind it was: one name lives in one ontology,
      // and the other statement simply matches nothing.
      const rels = await c.query(
        `UPDATE ${this.t("relations")} SET type = $1 WHERE type = $2 AND ns = $3`,
        [to, from, scope],
      );
      rows += rels.rowCount ?? 0;

      const declared = await c.query(
        `SELECT 1 FROM ${this.t("ontology_types")} WHERE name = $1 AND ns = $2 LIMIT 1`,
        [to, scope],
      );
      if ((declared.rowCount ?? 0) > 0) {
        // `to` already exists — the ordinary case when the code was renamed before the database was,
        // so a later `yoke init` seeded the new type beside the old one. Retire the stale declaration
        // rather than colliding with the live one; the rows above already point at the survivor.
        const gone = await c.query(
          `DELETE FROM ${this.t("ontology_types")} WHERE name = $1 AND ns = $2`,
          [from, scope],
        );
        rows += gone.rowCount ?? 0;
      } else {
        // saveOntology appends a version per name, which would leave every `from` row sitting there,
        // so these are rewritten in place — the name column and the name inside `def`.
        const moved = await c.query(
          `UPDATE ${this.t("ontology_types")}
              SET name = $1, def = jsonb_set(def, '{name}', to_jsonb($1::text))
            WHERE name = $2 AND ns = $3`,
          [to, from, scope],
        );
        rows += moved.rowCount ?? 0;
      }
      return rows;
    });
  }
}
