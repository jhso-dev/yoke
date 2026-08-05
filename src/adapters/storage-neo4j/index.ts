// storage-neo4j — the Neo4j implementation of StoragePort (v5.2).
//
// The first backend with native full-text search, native vectors AND native graph traversal in one
// engine (docs/BACKENDS.md capability matrix). sqlite ranks with FTS5 but walks the graph app-level;
// kuzu walks natively but ranks app-level and has no vectors; this does all three in Cypher.
//
// Two policies are copied from sqlite deliberately, because they are contract, not implementation:
//
//   1. **Only the latest version is searchable.** `putEntity` sets `txt` on the new version node and
//      REMOVES it from older ones, so the full-text index contains latest versions only — the same
//      thing sqlite achieves by delete+insert on `entities_fts`. Without it an old version could match
//      a query its current version no longer does.
//   2. **The vector lives beside the knowledge but not on it.** `(:EntityVec {id, embedding})`, one
//      node per entity id, mirroring sqlite's separate `entity_vec` table. That is what makes
//      `putEmbedding` a derived-index write rather than a knowledge write, so a backfill creates no
//      version and invalidates no citation (SPEC "The vector index").
//
// ns is stored as "" for the default shared namespace rather than null: Neo4j drops null properties,
// and an index lookup on a missing property is not the same query as one on a sentinel. Same choice
// kuzu made, for the same reason.

import neo4j, { type Driver, type Session } from "neo4j-driver-lite";
import { dimensionMismatch, serializeText } from "../../core/embedding.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { requireEveryTerm, tokenize } from "../../core/rank.js";
import type { Entity, Relation } from "../../core/types.js";
import {
  DEFAULT_SEARCH_LIMIT,
  type ListQuery,
  orderByIds,
  type Page,
  page,
  type StoragePort,
  type TextQuery,
} from "../../ports/storage.js";

const ENTITY_FTS = "yoke_entity_fts";
const ENTITY_VEC = "yoke_entity_vec";

/** Cypher run at init(). All IF NOT EXISTS — init() is the upgrade path for an existing database, the
 * same property sqlite's schema has. */
const SCHEMA = [
  // (id, version) is the real key; a synthetic pk gives Neo4j one property to make unique.
  `CREATE CONSTRAINT yoke_entity_pk IF NOT EXISTS
     FOR (e:Entity) REQUIRE e.pk IS UNIQUE`,
  `CREATE CONSTRAINT yoke_relation_pk IF NOT EXISTS
     FOR (r:Relation) REQUIRE r.pk IS UNIQUE`,
  `CREATE CONSTRAINT yoke_entityvec_id IF NOT EXISTS
     FOR (v:EntityVec) REQUIRE v.id IS UNIQUE`,
  `CREATE CONSTRAINT yoke_ontology_pk IF NOT EXISTS
     FOR (o:Ontology) REQUIRE o.pk IS UNIQUE`,
  // The reads that would otherwise scan. Mirrors the sqlite index set and the queries are the same
  // shapes (docs/SCALE.md names what each one costs without it).
  `CREATE INDEX yoke_entity_id IF NOT EXISTS FOR (e:Entity) ON (e.id)`,
  `CREATE INDEX yoke_entity_ns_type IF NOT EXISTS FOR (e:Entity) ON (e.ns, e.type)`,
  `CREATE INDEX yoke_entity_ns_status IF NOT EXISTS FOR (e:Entity) ON (e.ns, e.status)`,
  `CREATE INDEX yoke_relation_id IF NOT EXISTS FOR (r:Relation) ON (r.id)`,
  `CREATE INDEX yoke_relation_from IF NOT EXISTS FOR (r:Relation) ON (r.from_id)`,
  `CREATE INDEX yoke_relation_to IF NOT EXISTS FOR (r:Relation) ON (r.to_id)`,
  `CREATE INDEX yoke_ontology_name IF NOT EXISTS FOR (o:Ontology) ON (o.name)`,
  // Native full-text. `txt` is present on latest versions only (policy 1 above), so the index is
  // implicitly latest-only and its score can order the results directly.
  `CREATE FULLTEXT INDEX ${ENTITY_FTS} IF NOT EXISTS FOR (e:Entity) ON EACH [e.txt]`,
];

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
  ns?: string | null;
}

interface RelationRow extends EntityRow {
  from_id: string;
  to_id: string;
}

function rowToEntity(r: EntityRow): Entity {
  const e: Entity = {
    id: r.id,
    version: Number(r.version),
    type: r.type,
    status: r.status as Entity["status"],
    attributes: JSON.parse(r.attributes),
    provenance: JSON.parse(r.provenance),
    last_confirmed: r.last_confirmed,
  };
  // "" is the default-namespace sentinel; the Entity contract leaves the field absent for it.
  if (r.ns) e.ns = r.ns;
  return e;
}

function rowToRelation(r: RelationRow): Relation {
  return { ...rowToEntity(r), from: r.from_id, to: r.to_id };
}

/** Lucene metacharacters. A query is user text, so it is escaped before it becomes a Lucene
 * expression — otherwise a record containing a colon or a bracket makes the search throw. */
const LUCENE_SPECIAL = /([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g;

/**
 * A search query as Lucene: `+tok* tok` per token. Two clauses, and both are load-bearing.
 *
 * `+tok*` matches — prefix tolerance is conformance case 6b (a query for `parseArgs` must reach the
 * token `parseArgs로`, because Hangul are letters and stay attached to their stem) and the repeated
 * `+` gives 6c, multi-word AND in any order. Past AND_TERM_LIMIT tokens the `+` is dropped, which is
 * Lucene's own default operator and makes the query a disjunction the index's score then ranks
 * (SPEC search clause 8).
 *
 * `tok` is OPTIONAL and does the RANKING. Found by the conformance suite: Lucene rewrites a wildcard
 * as a CONSTANT_SCORE query, so a query of `+tok*` alone scores every hit identically and "best match
 * first" collapsed to id order — the record that merely mentions a term tied with the record about it.
 * The optional exact clause is what BM25 actually scores, so term frequency and length normalisation
 * come back. Documents matching only by prefix still match, they just carry no BM25 contribution.
 *
 * Returns null when the query has no usable tokens, which the caller turns into an empty result rather
 * than a Lucene syntax error.
 */
function luceneQuery(text: string, terms?: "auto" | "all"): string | null {
  const tokens = tokenize(text).map((t) => t.replace(LUCENE_SPECIAL, "\\$1"));
  if (tokens.length === 0) return null;
  const req = requireEveryTerm(tokens.length, terms) ? "+" : "";
  return tokens.map((t) => `${req}${t}* ${t}`).join(" ");
}

export class Neo4jStorage implements StoragePort {
  private driver: Driver;
  private readonly database?: string;
  /** The vector index's declared width, or null when it does not exist yet. Read from the server at
   * init() so it is right for a database this process did not create — the same reason sqlite reads
   * its width out of the stored DDL rather than tracking it in memory. */
  private vectorDim: number | null = null;

  constructor(opts: {
    url: string;
    user?: string;
    password?: string;
    database?: string;
  }) {
    this.database = opts.database;
    // Basic auth always. An unauthenticated server ignores the credentials, and the alternatives both
    // fight the types: `auth.none()` is not assignable to this package's AuthToken, and `undefined`
    // widens the parameter to a union the overload does not accept.
    this.driver = neo4j.driver(
      opts.url,
      neo4j.auth.basic(opts.user ?? "", opts.password ?? ""),
      // Integers come back as JS numbers. yoke's only integer is `version`, which is small, so the
      // lossless-integer wrapper would be conversion noise on every read for no safety gained.
      { disableLosslessIntegers: true },
    );
  }

  private session(): Session {
    return this.driver.session(
      this.database ? { database: this.database } : undefined,
    );
  }

  /** One query, one session. Returns plain records. */
  private async run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const s = this.session();
    try {
      const res = await s.run(cypher, params);
      return res.records.map((r) => r.toObject());
    } finally {
      await s.close();
    }
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA) await this.run(stmt);
    this.vectorDim = await this.readVectorDim();
  }

  close(): void {
    // The driver's close is async; the port's is not (it was shaped by better-sqlite3). Nothing reads
    // the promise, and leaving it unhandled would be an unhandled rejection on a broken connection.
    void this.driver.close().catch(() => {});
  }

  /** The vector index's width, from the server. null when the index is absent. */
  private async readVectorDim(): Promise<number | null> {
    const rows = await this.run(
      `SHOW INDEXES YIELD name, options WHERE name = $name RETURN options AS options`,
      { name: ENTITY_VEC },
    );
    const opts = rows[0]?.options as
      | { indexConfig?: Record<string, unknown> }
      | undefined;
    const dim = opts?.indexConfig?.["vector.dimensions"];
    return typeof dim === "number" ? dim : null;
  }

  // --- writes -------------------------------------------------------------------------------------

  async putEntity(e: Entity): Promise<void> {
    const ns = normalizeNs(e.ns) ?? "";
    const txt = serializeText(e.type, JSON.stringify(e.attributes));
    await this.run(
      `CREATE (e:Entity {pk:$pk, id:$id, version:$version, type:$type, status:$status,
         attributes:$attributes, provenance:$provenance, last_confirmed:$last_confirmed,
         txt:$txt, ns:$ns})
       WITH e
       // Only the latest version is searchable: strip txt from every older version of this id, so the
       // full-text index holds one node per entity. sqlite does the same with delete+insert.
       // No backticks in this string: it is a template literal and one would end it.
       MATCH (old:Entity {id:$id}) WHERE old.version < $version AND old.txt IS NOT NULL
       REMOVE old.txt`,
      {
        pk: `${e.id}#${e.version}`,
        id: e.id,
        version: e.version,
        type: e.type,
        status: e.status,
        attributes: JSON.stringify(e.attributes),
        provenance: JSON.stringify(e.provenance),
        last_confirmed: e.last_confirmed,
        txt,
        ns,
      },
    );
    if (e.embedding) await this.indexEmbedding(e.id, e.embedding);
  }

  async putRelation(r: Relation): Promise<void> {
    const ns = normalizeNs(r.ns) ?? "";
    await this.run(
      `CREATE (r:Relation {pk:$pk, id:$id, version:$version, type:$type, status:$status,
         attributes:$attributes, provenance:$provenance, last_confirmed:$last_confirmed,
         from_id:$from_id, to_id:$to_id, ns:$ns})`,
      {
        pk: `${r.id}#${r.version}`,
        id: r.id,
        version: r.version,
        type: r.type,
        status: r.status,
        attributes: JSON.stringify(r.attributes),
        provenance: JSON.stringify(r.provenance),
        last_confirmed: r.last_confirmed,
        from_id: r.from,
        to_id: r.to,
        ns,
      },
    );
  }

  /** The vector half of a write, keyed by entity id — shared by putEntity and putEmbedding so a
   * backfilled vector is identical to one written at commit time. */
  private async indexEmbedding(
    id: string,
    embedding: Float32Array,
    rebuild = false,
  ): Promise<void> {
    await this.ensureVectorIndex(embedding.length, rebuild);
    await this.run(
      `MERGE (v:EntityVec {id:$id})
       SET v.embedding = $embedding`,
      { id, embedding: Array.from(embedding) },
    );
  }

  async putEmbedding(e: Entity, opts?: { rebuild?: boolean }): Promise<void> {
    if (!e.embedding) return;
    await this.indexEmbedding(e.id, e.embedding, opts?.rebuild);
  }

  /**
   * The vector index, created at the first vector's width.
   *
   * A later vector of a different width is a changed embedding model, and it is refused here with both
   * widths and the command that fixes it — the one place the product deliberately stops a write over an
   * embedding problem, because a mixed vector space returns confidently wrong neighbours forever
   * (SPEC "The vector index"). Same rule and same message as sqlite and qdrant.
   */
  private async ensureVectorIndex(dim: number, rebuild = false): Promise<void> {
    if (rebuild && this.vectorDim !== null) {
      await this.run(`DROP INDEX ${ENTITY_VEC} IF EXISTS`);
      // The old vectors are the wrong width; leaving them would fail the new index's constraint.
      await this.run(`MATCH (v:EntityVec) REMOVE v.embedding`);
      this.vectorDim = null;
    }
    if (this.vectorDim !== null) {
      if (this.vectorDim !== dim) {
        throw dimensionMismatch(this.vectorDim, dim, false);
      }
      return;
    }
    await this.run(
      `CREATE VECTOR INDEX ${ENTITY_VEC} IF NOT EXISTS FOR (v:EntityVec) ON v.embedding
       OPTIONS {indexConfig: {\`vector.dimensions\`: $dim, \`vector.similarity_function\`: 'cosine'}}`,
      // neo4j.int: the driver sends a JS number as a float, and the index config rejects `8.0`
      // with "Expected a map from String to String" — an error that names neither the field nor the type.
      { dim: neo4j.int(dim) },
    );
    // The index is populated asynchronously; a query issued before it is online returns nothing.
    await this.run(`CALL db.awaitIndex($name, 60)`, { name: ENTITY_VEC }).catch(
      () => {
        // Older servers name this differently, and an unavailable wait is not a failed write.
      },
    );
    this.vectorDim = dim;
  }

  // --- reads --------------------------------------------------------------------------------------

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const rows =
      version === undefined
        ? await this.run(
            `MATCH (e:Entity {id:$id}) RETURN e ORDER BY e.version DESC LIMIT 1`,
            { id },
          )
        : await this.run(`MATCH (e:Entity {pk:$pk}) RETURN e`, {
            pk: `${id}#${version}`,
          });
    const node = rows[0]?.e as { properties: EntityRow } | undefined;
    return node ? rowToEntity(node.properties) : null;
  }

  /** Batch point read (v5.5) — one Cypher for the whole set. The latest-version collapse is the same
   * two-step `similar` already uses, which is why Neo4j was the one backend whose `similar` was not
   * an N+1 to begin with. */
  async getEntities(ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    const rows = await this.run(
      `MATCH (e:Entity) WHERE e.id IN $ids
       WITH e.id AS eid, max(e.version) AS mv
       MATCH (e:Entity {id:eid, version:mv}) RETURN e`,
      { ids },
    );
    return orderByIds(
      rows.map((row) =>
        rowToEntity((row.e as { properties: EntityRow }).properties),
      ),
      ids,
    );
  }

  /**
   * Relations touching `id`, latest version each.
   *
   * Real Cypher with both single-column indexes, not a scan: kuzu materializes EVERY relation and
   * filters in JS (`storage-kuzu/index.ts:194`), which is the ceiling its own comment names. The
   * latest-version collapse happens BEFORE the type/direction filter, because an older version of a
   * relation could match a filter its current version does not.
   */
  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const rows = await this.run(
      `MATCH (r:Relation) WHERE r.from_id = $id OR r.to_id = $id
       WITH r.id AS rid, max(r.version) AS mv
       MATCH (r:Relation {id:rid, version:mv})
       WHERE ($relType IS NULL OR r.type = $relType)
         AND ($dir IS NULL
              OR ($dir = 'out' AND r.from_id = $id)
              OR ($dir = 'in'  AND r.to_id  = $id))
       RETURN r`,
      { id, relType: relType ?? null, dir: dir ?? null },
    );
    return rows.map((row) =>
      rowToRelation((row.r as { properties: RelationRow }).properties),
    );
  }

  /**
   * Native full-text search, ordered by the index's own score.
   *
   * This is the one place Neo4j is structurally better than every other backend: sqlite has FTS5's
   * bm25 but no graph, kuzu has the graph but ranks app-level over a full scan. Here the ranking is
   * the index's, so SPEC's "best match first" clause is satisfied natively and `core/rank.ts` is not
   * needed.
   *
   * `txt` exists only on latest versions (putEntity strips it from older ones), so the index cannot
   * return a stale version and no collapse pass is needed here.
   */
  async search(q: TextQuery): Promise<Entity[]> {
    const lucene = luceneQuery(q.text, q.terms);
    if (lucene === null) return [];
    const wantNs = normalizeNs(q.ns) ?? "";
    const statuses = Array.isArray(q.status)
      ? q.status
      : q.status === undefined
        ? null
        : [q.status];
    const rows = await this.run(
      `CALL db.index.fulltext.queryNodes($index, $lucene) YIELD node AS e, score
       WHERE e.ns = $ns
         AND ($type IS NULL OR e.type = $type)
         AND ($statuses IS NULL OR e.status IN $statuses)
       RETURN e ORDER BY score DESC, e.id ASC LIMIT $limit`,
      {
        index: ENTITY_FTS,
        lucene,
        ns: wantNs,
        type: q.type ?? null,
        statuses,
        // ns/type/status filter before the limit (SPEC search clause), and the default bound applies
        // when the caller names none — an unbounded search is what exhausted the heap at 10M rows.
        limit: neo4j.int(q.limit ?? DEFAULT_SEARCH_LIMIT),
      },
    );
    return rows.map((row) =>
      rowToEntity((row.e as { properties: EntityRow }).properties),
    );
  }

  /** KNN over the vector index. Returns entities with `.embedding` restored — the gate applies the
   * cosine threshold itself. Empty when no vector was ever stored. */
  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    if (this.vectorDim === null) return [];
    // Reads get the same dimension check as writes: querying the old index with a new model's vector
    // answers out of a different vector space, which looks like a result and is not one.
    if (this.vectorDim !== embedding.length) {
      throw dimensionMismatch(this.vectorDim, embedding.length, true);
    }
    const rows = await this.run(
      `CALL db.index.vector.queryNodes($index, $k, $vec) YIELD node AS v, score
       MATCH (e:Entity {id: v.id})
       WITH v, score, e.id AS eid, max(e.version) AS mv
       MATCH (e:Entity {id:eid, version:mv})
       RETURN e, v.embedding AS embedding, score ORDER BY score DESC`,
      { index: ENTITY_VEC, k: neo4j.int(k), vec: Array.from(embedding) },
    );
    return rows.map((row) => {
      const e = rowToEntity((row.e as { properties: EntityRow }).properties);
      const vec = row.embedding as number[] | null;
      if (vec) e.embedding = Float32Array.from(vec);
      return e;
    });
  }

  async listEntities(q: ListQuery): Promise<Page<Entity>> {
    const rows = await this.run(
      `MATCH (e:Entity)
       WITH e.id AS eid, max(e.version) AS mv
       MATCH (e:Entity {id:eid, version:mv})
       // Filters apply to the LATEST version only, which is why the collapse comes first: an older
       // row of the same id could match a filter the current version does not.
       WHERE e.ns = $ns
         AND ($type IS NULL OR e.type = $type)
         AND ($status IS NULL OR e.status = $status)
         AND ($after IS NULL OR e.id > $after)
       RETURN e ORDER BY e.id ASC LIMIT $limit`,
      this.listParams(q),
    );
    return page(
      rows.map((row) =>
        rowToEntity((row.e as { properties: EntityRow }).properties),
      ),
      q.limit,
    );
  }

  async listRelations(q: ListQuery): Promise<Page<Relation>> {
    const rows = await this.run(
      `MATCH (r:Relation)
       WITH r.id AS rid, max(r.version) AS mv
       MATCH (r:Relation {id:rid, version:mv})
       WHERE r.ns = $ns
         AND ($type IS NULL OR r.type = $type)
         AND ($status IS NULL OR r.status = $status)
         AND ($after IS NULL OR r.id > $after)
       RETURN r ORDER BY r.id ASC LIMIT $limit`,
      this.listParams(q),
    );
    return page(
      rows.map((row) =>
        rowToRelation((row.r as { properties: RelationRow }).properties),
      ),
      q.limit,
    );
  }

  /** Shared so both listings agree, including the over-read by one that makes `next` truthful
   * (ports/storage.ts `page`). An omitted limit enumerates everything — enumeration is a cursor walk
   * the caller drives, the opposite default from search. */
  private listParams(q: ListQuery): Record<string, unknown> {
    return {
      ns: normalizeNs(q.ns) ?? "",
      type: q.type ?? null,
      status: q.status ?? null,
      after: q.after ?? null,
      limit:
        q.limit === undefined
          ? neo4j.int(Number.MAX_SAFE_INTEGER)
          : neo4j.int(q.limit + 1),
    };
  }

  // --- ontology (async, unlike sqlite's — see SPEC "Remote backends") -----------------------------

  /** Append-only per name, mirroring sqlite: a repeated name adds a version and load returns the
   * latest. `seq` preserves first-registration order so the ontology reads in declaration order. */
  async saveOntology(defs: TypeDef[], ns?: string | null): Promise<void> {
    const n = normalizeNs(ns) ?? "";
    const seqRow = await this.run(
      `MATCH (o:Ontology {ns:$ns}) RETURN max(o.seq) AS m`,
      { ns: n },
    );
    let seq = Number(seqRow[0]?.m ?? 0);
    for (const def of defs) {
      const vRow = await this.run(
        `MATCH (o:Ontology {ns:$ns, name:$name}) RETURN max(o.version) AS m`,
        { ns: n, name: def.name },
      );
      const version = Number(vRow[0]?.m ?? 0) + 1;
      seq += 1;
      await this.run(
        `CREATE (o:Ontology {pk:$pk, ns:$ns, name:$name, version:$version, def:$def, seq:$seq})`,
        {
          pk: `${n}#${def.name}#${version}`,
          ns: n,
          name: def.name,
          version,
          def: JSON.stringify(def),
          seq,
        },
      );
    }
  }

  async loadOntology(ns?: string | null): Promise<TypeDef[]> {
    const n = normalizeNs(ns) ?? "";
    const rows = await this.run(
      `MATCH (o:Ontology {ns:$ns})
       WITH o.name AS name, max(o.version) AS mv, min(o.seq) AS firstSeq
       MATCH (l:Ontology {ns:$ns, name:name, version:mv})
       RETURN l.def AS def ORDER BY firstSeq ASC`,
      { ns: n },
    );
    return rows.map((r) => JSON.parse(r.def as string) as TypeDef);
  }

  /** Rewrites every row carrying the name, history included — the one mutation the append-only
   * history cannot record, which is why the front tier writes a `rename_type` audit row for it. */
  async renameType(
    from: string,
    to: string,
    ns?: string | null,
  ): Promise<number> {
    const n = normalizeNs(ns) ?? "";
    let rows = 0;
    for (const label of ["Entity", "Relation"]) {
      const r = await this.run(
        `MATCH (x:${label} {ns:$ns, type:$from}) SET x.type = $to RETURN count(x) AS c`,
        { ns: n, from, to },
      );
      rows += Number(r[0]?.c ?? 0);
    }
    // The declaration too, and a rename onto an existing name drops the old declaration rather than
    // leaving two — the same resolution sqlite's implementation takes.
    const decl = await this.run(
      `MATCH (o:Ontology {ns:$ns, name:$from})
       WITH collect(o) AS olds
       CALL {
         WITH olds
         UNWIND olds AS o
         SET o.name = $to, o.def = replace(o.def, '"name":"' + $from + '"', '"name":"' + $to + '"')
         RETURN count(o) AS c
       }
       RETURN c`,
      { ns: n, from, to },
    );
    rows += Number(decl[0]?.c ?? 0);
    // Re-serialize `txt` for the rows whose type changed: it embeds the type name, and the full-text
    // index would otherwise keep answering for the old vocabulary.
    if (rows > 0) {
      const affected = await this.run(
        `MATCH (e:Entity {ns:$ns, type:$to}) WHERE e.txt IS NOT NULL
         RETURN e.id AS id, e.version AS version, e.attributes AS attributes`,
        { ns: n, to },
      );
      for (const a of affected) {
        await this.run(`MATCH (e:Entity {pk:$pk}) SET e.txt = $txt`, {
          pk: `${a.id}#${a.version}`,
          txt: serializeText(to, a.attributes as string),
        });
      }
    }
    return rows;
  }
}
