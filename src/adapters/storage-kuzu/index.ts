// storage-kuzu — the kuzu (embedded graph DB) implementation of StoragePort (PLAN-V2 8.1).
// append-only: only (id, version) records are added, never mutated. Mirrors sqlite semantics.
// Kuzu is schema-strict and has no FTS5, so entities/relations/ontology are stored as node
// tables (attributes/provenance as JSON strings) and search runs app-level over serialized text.
// `similar` is omitted (capability absent — see BACKENDS.md capability matrix).

import kuzu from "kuzu";
import { serializeText } from "../../core/embedding.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type { StoragePort, TextQuery } from "../../ports/storage.js";

// Kuzu needs a single-column PRIMARY KEY, so the composite (id, version) becomes a synthetic pk.
// `#` cannot collide because ids are opaque ULIDs and version is an integer.
const SCHEMA = [
  // ns = tenant namespace (PLAN-V2 10.1). Stored as a string; "" means the default shared ns
  // (Kuzu is schema-strict, so an empty-string sentinel is simpler than a nullable column).
  `CREATE NODE TABLE IF NOT EXISTS Entity (
     pk STRING PRIMARY KEY, id STRING, version INT64, type STRING, status STRING,
     attributes STRING, provenance STRING, last_confirmed STRING, txt STRING, ns STRING
   )`,
  `CREATE NODE TABLE IF NOT EXISTS Relation (
     pk STRING PRIMARY KEY, id STRING, version INT64, type STRING, status STRING,
     attributes STRING, provenance STRING, last_confirmed STRING, from_id STRING, to_id STRING, ns STRING
   )`,
  // seq preserves first-registration order for loadOntology (mirrors sqlite's MIN(rowid) ordering).
  `CREATE NODE TABLE IF NOT EXISTS Ontology (
     pk STRING PRIMARY KEY, name STRING, version INT64, def STRING, seq INT64
   )`,
];

interface EntityRow {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
  ns?: string;
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
  // "" sentinel = default namespace → leave the field absent (opaque parity).
  if (r.ns) e.ns = r.ns;
  return e;
}

function rowToRelation(r: RelationRow): Relation {
  return { ...rowToEntity(r), from: r.from_id, to: r.to_id };
}

// Keep only the max-version record per id (append-only re-commits accumulate rows).
function latestByVersion<T extends { id: string; version: number }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.id);
    if (!cur || Number(r.version) > Number(cur.version)) best.set(r.id, r);
  }
  return [...best.values()];
}

export class KuzuStorage implements StoragePort {
  private db: kuzu.Database;
  private conn: kuzu.Connection;

  constructor(path: string) {
    this.db = new kuzu.Database(path);
    this.conn = new kuzu.Connection(this.db);
  }

  async init(): Promise<void> {
    for (const stmt of SCHEMA) await this.conn.query(stmt);
    // Migration for pre-10.1 DBs: add the ns column. Fresh tables already declare it (SCHEMA), so
    // ADD throws — caught and ignored. DEFAULT '' assigns existing rows to the default shared ns.
    for (const table of ["Entity", "Relation"]) {
      try {
        await this.conn.query(`ALTER TABLE ${table} ADD ns STRING DEFAULT ''`);
      } catch {
        // column already exists — nothing to do.
      }
    }
  }

  close(): void {
    // closeSync() aborts the process when kuzu's background threads are still
    // winding down (kills the vitest fork's IPC channel — ERR_IPC_CHANNEL_CLOSED
    // observed on Linux CI and locally). The async close() path shuts down
    // cooperatively; fire-and-forget is safe because kuzu flushes on close and
    // every write already awaited its query before returning.
    void this.conn.close().then(() => this.db.close());
  }

  private async run(
    cypher: string,
    params: Record<string, kuzu.KuzuValue>,
  ): Promise<Record<string, kuzu.KuzuValue>[]> {
    const ps = await this.conn.prepare(cypher);
    const res = (await this.conn.execute(ps, params)) as kuzu.QueryResult;
    return res.getAll();
  }

  async putEntity(e: Entity): Promise<void> {
    // embedding is ignored — this backend omits `similar`.
    await this.run(
      `CREATE (e:Entity {pk:$pk, id:$id, version:$version, type:$type, status:$status,
         attributes:$attributes, provenance:$provenance, last_confirmed:$last_confirmed, txt:$txt, ns:$ns})`,
      {
        pk: `${e.id}#${e.version}`,
        id: e.id,
        version: e.version,
        type: e.type,
        status: e.status,
        attributes: JSON.stringify(e.attributes),
        provenance: JSON.stringify(e.provenance),
        last_confirmed: e.last_confirmed,
        txt: serializeText(e.type, JSON.stringify(e.attributes)),
        ns: normalizeNs(e.ns) ?? "",
      },
    );
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const rows = (await this.run(
      version === undefined
        ? `MATCH (e:Entity) WHERE e.id = $id
           RETURN e.id AS id, e.version AS version, e.type AS type, e.status AS status,
             e.attributes AS attributes, e.provenance AS provenance, e.last_confirmed AS last_confirmed, e.ns AS ns
           ORDER BY e.version DESC LIMIT 1`
        : `MATCH (e:Entity) WHERE e.id = $id AND e.version = $version
           RETURN e.id AS id, e.version AS version, e.type AS type, e.status AS status,
             e.attributes AS attributes, e.provenance AS provenance, e.last_confirmed AS last_confirmed, e.ns AS ns`,
      version === undefined ? { id } : { id, version },
    )) as unknown as EntityRow[];
    return rows.length ? rowToEntity(rows[0]) : null;
  }

  async putRelation(r: Relation): Promise<void> {
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
        ns: normalizeNs(r.ns) ?? "",
      },
    );
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const all = (await this.run(
      `MATCH (r:Relation)
       RETURN r.id AS id, r.version AS version, r.type AS type, r.status AS status,
         r.attributes AS attributes, r.provenance AS provenance, r.last_confirmed AS last_confirmed,
         r.from_id AS from_id, r.to_id AS to_id, r.ns AS ns`,
      {},
    )) as unknown as RelationRow[];
    // Filter to latest version per id first (mirrors sqlite: the dir/type filter applies to the
    // latest row), then apply direction + relType.
    return latestByVersion(all)
      .filter((r) => {
        const matchDir =
          dir === "out"
            ? r.from_id === id
            : dir === "in"
              ? r.to_id === id
              : r.from_id === id || r.to_id === id;
        return matchDir && (relType === undefined || r.type === relType);
      })
      .map(rowToRelation);
  }

  async search(q: TextQuery): Promise<Entity[]> {
    const all = (await this.run(
      `MATCH (e:Entity)
       RETURN e.id AS id, e.version AS version, e.type AS type, e.status AS status,
         e.attributes AS attributes, e.provenance AS provenance, e.last_confirmed AS last_confirmed,
         e.txt AS txt, e.ns AS ns`,
      {},
    )) as unknown as (EntityRow & { txt: string })[];
    // Prefix-tolerant token match over serialized text (Kuzu has no FTS5). Tokens split on any
    // non-letter/non-number char, so JSON punctuation separates but an attached particle stays on
    // its stem — every query token must prefix some entity token. Searching "parseArgs" thus finds
    // the token "parseArgs로" (Korean suffix tolerance, conformance case 6b).
    const qTokens = tokenize(q.text);
    const wantNs = normalizeNs(q.ns);
    const matched = latestByVersion(all).filter((r) => {
      const eTokens = tokenize(r.txt);
      return qTokens.every((qt) => eTokens.some((et) => et.startsWith(qt)));
    });
    const filtered = matched.filter(
      (r) =>
        // "" sentinel normalizes to null so the default ns sees only default rows (10.1 isolation).
        (r.ns || null) === wantNs &&
        (q.type === undefined || r.type === q.type) &&
        (q.status === undefined || r.status === q.status),
    );
    return (q.limit === undefined ? filtered : filtered.slice(0, q.limit)).map(
      rowToEntity,
    );
  }

  // --- Adapter extensions outside StoragePort: ontology seed save/load (mirrors sqlite) ---

  /** Append-only save: accumulates as the next version per name, recording insertion order in seq. */
  async saveOntology(defs: TypeDef[]): Promise<void> {
    const seqRows = (await this.run(
      `MATCH (o:Ontology) RETURN max(o.seq) AS m`,
      {},
    )) as unknown as { m: number | null }[];
    let seq = Number(seqRows[0]?.m ?? 0);
    for (const def of defs) {
      const vRows = (await this.run(
        `MATCH (o:Ontology) WHERE o.name = $name RETURN max(o.version) AS m`,
        { name: def.name },
      )) as unknown as { m: number | null }[];
      const version = Number(vRows[0]?.m ?? 0) + 1;
      seq += 1;
      await this.run(
        `CREATE (o:Ontology {pk:$pk, name:$name, version:$version, def:$def, seq:$seq})`,
        {
          pk: `${def.name}#${version}`,
          name: def.name,
          version,
          def: JSON.stringify(def),
          seq,
        },
      );
    }
  }

  /** Load only the latest version per name, in first-registration order. */
  async loadOntology(): Promise<TypeDef[]> {
    // seq of the first-registered (version 1) row orders names by first registration.
    const rows = (await this.run(
      `MATCH (o:Ontology)
       WITH o.name AS name, max(o.version) AS mv, min(o.seq) AS firstSeq
       MATCH (l:Ontology) WHERE l.name = name AND l.version = mv
       RETURN l.def AS def ORDER BY firstSeq`,
      {},
    )) as unknown as { def: string }[];
    return rows.map((r) => JSON.parse(r.def) as TypeDef);
  }
}

// Lowercase, then split on any run of non-letter/non-number characters (unicode-aware).
// Hangul are letters, so "parseArgs로" stays one token; JSON quotes/braces/colons separate.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
