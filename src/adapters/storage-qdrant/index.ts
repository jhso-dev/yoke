// storage-qdrant — the Qdrant implementation of StoragePort (PLAN-V2 8.2).
// REST via fetch only, no SDK. append-only: every (id, version) pair is its own point,
// keyed by a deterministic UUID of `${id}#${version}`; latest-version selection is done
// client-side. Mirrors the sqlite semantics (BACKENDS.md invariant 2 — same conformance suite).
//
// Collections (all created at init, payload-only via empty named-vectors config):
//   entities   — one point per entity version. payload: {id, version, type, status,
//                attributes(JSON), provenance(JSON), last_confirmed, txt}
//   relations  — one point per relation version. payload adds {from_id, to_id}
//   ontology   — one point per (name, version). payload: {name, version, def(JSON), seq}
// entity_vectors — created lazily on the first embedding (dim pinned to that vector,
//   same policy as sqlite's vec0 table). One point per entity id (delete+insert = latest only).

import { createHash } from "node:crypto";
import { serializeText } from "../../core/embedding.js";
import { normalizeNs } from "../../core/namespace.js";
import type { TypeDef } from "../../core/ontology.js";
import { matchesTokens, rankByRelevance, tokenize } from "../../core/rank.js";
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

const ENTITIES = "entities";
const RELATIONS = "relations";
const ONTOLOGY = "ontology";
const ENTITY_VECTORS = "entity_vectors";

// Qdrant point ids must be uint or UUID; derive a stable UUID from the composite key.
function pointId(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  // Format 8-4-4-4-12 with valid version(5)/variant(8) nibbles.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function latestByVersion<T extends { id: string; version: number }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const cur = best.get(r.id);
    if (!cur || r.version > cur.version) best.set(r.id, r);
  }
  return [...best.values()];
}

interface EntityPayload {
  id: string;
  version: number;
  type: string;
  status: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
  txt: string;
  ns: string | null; // tenant namespace (PLAN-V2 10.1); null = default shared ns
}
interface RelationPayload extends EntityPayload {
  from_id: string;
  to_id: string;
}

function payloadToEntity(p: EntityPayload): Entity {
  const e: Entity = {
    id: p.id,
    version: p.version,
    type: p.type,
    status: p.status as Entity["status"],
    attributes: JSON.parse(p.attributes),
    provenance: JSON.parse(p.provenance),
    last_confirmed: p.last_confirmed,
  };
  // Default namespace leaves the field absent (opaque parity).
  if (p.ns != null) e.ns = p.ns;
  return e;
}

function payloadToRelation(p: RelationPayload): Relation {
  return { ...payloadToEntity(p), from: p.from_id, to: p.to_id };
}

// Qdrant filter DSL — only the fragments this adapter relies on. The fake must honor these.
type Match = {
  key: string;
  /** `any` is qdrant's IN — one filter for a whole id set (see getEntities). */
  match: { value: string | number } | { any: string[] };
};
interface Filter {
  must?: Match[];
  should?: Match[];
}
interface ScrollPoint {
  id: string;
  payload: EntityPayload & Partial<RelationPayload>;
  vector?: number[];
}

export interface QdrantOptions {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class QdrantStorage implements StoragePort {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private vectorDim: number | null = null;

  constructor(opts: QdrantOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async init(): Promise<void> {
    // Payload-only collections: empty named-vectors map. entity_vectors is created lazily once a
    // vector dimension is known (respects the fixed constructor, mirrors sqlite's lazy vec0 table).
    for (const name of [ENTITIES, RELATIONS, ONTOLOGY]) {
      if (!(await this.collectionExists(name))) {
        await this.req("PUT", `/collections/${name}`, { vectors: {} });
      }
    }
    if (await this.collectionExists(ENTITY_VECTORS)) {
      const info = (await this.req(
        "GET",
        `/collections/${ENTITY_VECTORS}`,
      )) as {
        result?: { config?: { params?: { vectors?: { size?: number } } } };
      };
      this.vectorDim = info.result?.config?.params?.vectors?.size ?? null;
    }
  }

  // Stateless HTTP — nothing to release.
  close(): void {}

  private async req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`qdrant ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async collectionExists(name: string): Promise<boolean> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["api-key"] = this.apiKey;
    const res = await this.fetchImpl(`${this.url}/collections/${name}`, {
      method: "GET",
      headers,
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `qdrant GET /collections/${name} → ${res.status}: ${text}`,
      );
    }
    return true;
  }

  // Dimension is pinned to the first embedding (same as sqlite), and `init()` reads the real width off
  // an existing collection so the cached value is right for a database this process did not create.
  //
  // A later vector of a different width is a changed embedding model. Checked here rather than left to
  // qdrant's own rejection: a mixed vector space returns confidently wrong neighbours, so this is the
  // one place the product deliberately stops a write over an embedding problem, and the message has to
  // name the way out (SPEC "The vector index").
  private async ensureVectorCollection(
    dim: number,
    rebuild = false,
  ): Promise<void> {
    if (rebuild && (await this.collectionExists(ENTITY_VECTORS))) {
      await this.req("DELETE", `/collections/${ENTITY_VECTORS}`);
      this.vectorDim = null;
    }
    if (this.vectorDim !== null) {
      if (this.vectorDim !== dim) {
        throw new Error(
          `embedding dimension changed: the vector index holds ${this.vectorDim}-dimension vectors and this one is ${dim}. ` +
            `A database has one vector space — re-index every record with the new model: ` +
            `yoke backfill --embeddings --rebuild`,
        );
      }
      return;
    }
    if (!(await this.collectionExists(ENTITY_VECTORS))) {
      await this.req("PUT", `/collections/${ENTITY_VECTORS}`, {
        vectors: { size: dim, distance: "Cosine" },
      });
    }
    this.vectorDim = dim;
  }

  /** The vector half of a write, keyed by entity id. Shared by `putEntity` and `putEmbedding` so a
   * backfilled vector is identical to one written at commit time. */
  private async indexEmbedding(
    id: string,
    embedding: Float32Array,
    rebuild = false,
  ): Promise<void> {
    await this.ensureVectorCollection(embedding.length, rebuild);
    await this.req("PUT", `/collections/${ENTITY_VECTORS}/points`, {
      points: [
        { id: pointId(id), payload: { id }, vector: Array.from(embedding) },
      ],
    });
  }

  async putEmbedding(e: Entity, opts?: { rebuild?: boolean }): Promise<void> {
    if (!e.embedding) return;
    await this.indexEmbedding(e.id, e.embedding, opts?.rebuild);
  }

  // Page through a collection under an optional filter (conformance scale — 256/page is plenty).
  private async scrollAll(
    collection: string,
    filter?: Filter,
    withVector = false,
  ): Promise<ScrollPoint[]> {
    const out: ScrollPoint[] = [];
    let offset: string | number | null | undefined;
    do {
      const res = (await this.req(
        "POST",
        `/collections/${collection}/points/scroll`,
        {
          filter,
          limit: 256,
          offset,
          with_payload: true,
          with_vector: withVector,
        },
      )) as {
        result: {
          points: ScrollPoint[];
          next_page_offset?: string | number | null;
        };
      };
      out.push(...res.result.points);
      offset = res.result.next_page_offset;
    } while (offset !== null && offset !== undefined);
    return out;
  }

  async putEntity(e: Entity): Promise<void> {
    const attributes = JSON.stringify(e.attributes);
    const payload: EntityPayload = {
      id: e.id,
      version: e.version,
      type: e.type,
      status: e.status,
      attributes,
      provenance: JSON.stringify(e.provenance),
      last_confirmed: e.last_confirmed,
      txt: serializeText(e.type, attributes),
      ns: normalizeNs(e.ns),
    };
    // vector: {} — real Qdrant requires the field even in an empty-named-vectors
    // collection (found in live verification; the original fake tolerated its absence).
    await this.req("PUT", `/collections/${ENTITIES}/points`, {
      points: [{ id: pointId(`${e.id}#${e.version}`), payload, vector: {} }],
    });
    // Keep only the latest version's vector: one point per entity id (re-upsert overwrites).
    // Touched only when an embedding is present — a versionless re-put leaves the old vector,
    // same as sqlite (payload has no vector to reconstruct from).
    if (e.embedding) await this.indexEmbedding(e.id, e.embedding);
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    const must: Match[] = [{ key: "id", match: { value: id } }];
    if (version !== undefined)
      must.push({ key: "version", match: { value: version } });
    const points = await this.scrollAll(ENTITIES, { must });
    if (points.length === 0) return null;
    const rows = points.map((p) => p.payload as EntityPayload);
    if (version !== undefined) return payloadToEntity(rows[0]);
    return payloadToEntity(latestByVersion(rows)[0]);
  }

  /** Batch point read (v5.5) — one scroll under an `any` filter instead of one scroll per id.
   * The empty guard is load-bearing here and nowhere else: an empty `any` list is a filter that
   * matches nothing on some qdrant versions and everything on others, and "everything" would hand
   * back the corpus. */
  async getEntities(ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    const points = await this.scrollAll(ENTITIES, {
      must: [{ key: "id", match: { any: ids } }],
    });
    const rows = latestByVersion(points.map((p) => p.payload as EntityPayload));
    return orderByIds(rows.map(payloadToEntity), ids);
  }

  async putRelation(r: Relation): Promise<void> {
    const payload: RelationPayload = {
      id: r.id,
      version: r.version,
      type: r.type,
      status: r.status,
      attributes: JSON.stringify(r.attributes),
      provenance: JSON.stringify(r.provenance),
      last_confirmed: r.last_confirmed,
      txt: "",
      ns: normalizeNs(r.ns),
      from_id: r.from,
      to_id: r.to,
    };
    await this.req("PUT", `/collections/${RELATIONS}/points`, {
      points: [{ id: pointId(`${r.id}#${r.version}`), payload, vector: {} }],
    });
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    const filter: Filter = {};
    if (dir === "out") filter.must = [{ key: "from_id", match: { value: id } }];
    else if (dir === "in")
      filter.must = [{ key: "to_id", match: { value: id } }];
    else
      filter.should = [
        { key: "from_id", match: { value: id } },
        { key: "to_id", match: { value: id } },
      ];
    if (relType !== undefined) {
      filter.must ??= [];
      filter.must.push({ key: "type", match: { value: relType } });
    }
    const points = await this.scrollAll(RELATIONS, filter);
    const rows = points.map((p) => p.payload as RelationPayload);
    return latestByVersion(rows).map(payloadToRelation);
  }

  async search(q: TextQuery): Promise<Entity[]> {
    // ponytail: full scan + client-side token-prefix match (O(n)), no server-side full-text index.
    // Honest at conformance scale; promote to a Qdrant full-text payload index if corpora grow.
    const points = await this.scrollAll(ENTITIES);
    const rows = latestByVersion(points.map((p) => p.payload as EntityPayload));
    const qTokens = tokenize(q.text);
    const wantNs = normalizeNs(q.ns);
    // AND up to AND_TERM_LIMIT terms, OR beyond it (SPEC search clause 8), shared with kuzu so the
    // two client-side matchers cannot answer the same query differently.
    const matched = rows.filter((r) => matchesTokens(qTokens, r.txt));
    const filtered = matched.filter(
      (r) =>
        // null-normalized ns so the default ns sees only default rows (10.1 isolation).
        (r.ns ?? null) === wantNs &&
        (q.type === undefined || r.type === q.type) &&
        (q.status === undefined ||
          (Array.isArray(q.status)
            ? q.status.includes(r.status)
            : r.status === q.status)),
    );
    // Best match first, then cut. Same reasoning as kuzu: the rows are already materialized by the
    // full scan above, so ranking them costs nothing on top and the slice stops being arbitrary.
    const ranked = rankByRelevance(filtered, q.text, (r) => r.txt);
    return ranked
      .slice(0, q.limit ?? DEFAULT_SEARCH_LIMIT)
      .map(payloadToEntity);
  }

  /** Enumerate latest-version entities, ascending by id.
   * The ordering is done client-side ON PURPOSE: scroll's `next_page_offset` is a point UUID
   * (hashed from the id+version, see pointId), not the entity's ULID, so it cannot serve as the
   * contract's keyset cursor and its order is unrelated to creation order.
   * ponytail: full scan + client-side sort, the same O(n) ceiling search() already carries. */
  async listEntities(q: ListQuery): Promise<Page<Entity>> {
    const points = await this.scrollAll(ENTITIES);
    const rows = points.map((p) => p.payload as EntityPayload);
    return page(this.listFilter(rows, q).map(payloadToEntity), q.limit);
  }

  /** Enumerate latest-version relations, ascending by id. q.type filters the relation type. */
  async listRelations(q: ListQuery): Promise<Page<Relation>> {
    const points = await this.scrollAll(RELATIONS);
    const rows = points.map((p) => p.payload as RelationPayload);
    return page(this.listFilter(rows, q).map(payloadToRelation), q.limit);
  }

  /** latest version → ns/type/status/cursor filter → ascending id. Shared so both listings agree. */
  private listFilter<T extends EntityPayload>(rows: T[], q: ListQuery): T[] {
    const wantNs = normalizeNs(q.ns);
    return latestByVersion(rows)
      .filter(
        (r) =>
          (r.ns ?? null) === wantNs &&
          (q.type === undefined || r.type === q.type) &&
          (q.status === undefined || r.status === q.status) &&
          (q.after === undefined || r.id > q.after),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, q.limit === undefined ? undefined : q.limit + 1);
  }

  /** KNN over latest-version entities. Empty when no embedding was ever stored (no vector collection).
   * Restores each hit's .embedding (the gate applies the cosine threshold). */
  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    if (this.vectorDim === null) return [];
    // Reads get the same dimension check as writes: querying the old index with a new model's vector
    // would answer out of a different vector space, which looks like a result and is not one.
    if (this.vectorDim !== embedding.length) {
      throw new Error(
        `embedding dimension changed: the vector index holds ${this.vectorDim}-dimension vectors and this query is ${embedding.length}. ` +
          `Re-index every record with the current model: yoke backfill --embeddings --rebuild`,
      );
    }
    const res = (await this.req(
      "POST",
      `/collections/${ENTITY_VECTORS}/points/search`,
      {
        vector: Array.from(embedding),
        limit: k,
        with_payload: true,
        with_vector: true,
      },
    )) as { result: Array<{ payload: { id: string }; vector?: number[] }> };
    // One batch read in score order, NOT one per hit (v5.5) — `similar` runs on every query
    // injection now that retrieval is hybrid, with k = limit x 3.
    const vectors = new Map(
      res.result.map((h) => [h.payload.id, h.vector] as const),
    );
    const rows = await this.getEntities([...vectors.keys()]);
    return rows.map((e) => {
      const vec = vectors.get(e.id);
      return vec ? { ...e, embedding: Float32Array.from(vec) } : e;
    });
  }

  // --- Adapter extensions outside StoragePort: ontology seed save/load (mirrors sqlite/kuzu) ---

  /** Append-only save: accumulates as the next version per name, recording insertion order in seq. */
  async saveOntology(defs: TypeDef[]): Promise<void> {
    const existing = await this.scrollAll(ONTOLOGY);
    let seq = existing.reduce(
      (m, p) => Math.max(m, (p.payload as unknown as { seq: number }).seq),
      0,
    );
    const versionOf = new Map<string, number>();
    for (const p of existing) {
      const row = p.payload as unknown as { name: string; version: number };
      versionOf.set(
        row.name,
        Math.max(versionOf.get(row.name) ?? 0, row.version),
      );
    }
    for (const def of defs) {
      const version = (versionOf.get(def.name) ?? 0) + 1;
      seq += 1;
      await this.req("PUT", `/collections/${ONTOLOGY}/points`, {
        points: [
          {
            id: pointId(`${def.name}#${version}`),
            payload: { name: def.name, version, def: JSON.stringify(def), seq },
            vector: {},
          },
        ],
      });
    }
  }

  /** Load only the latest version per name, in first-registration order (min seq of the name). */
  async loadOntology(): Promise<TypeDef[]> {
    const points = await this.scrollAll(ONTOLOGY);
    const rows = points.map(
      (p) =>
        p.payload as unknown as {
          name: string;
          version: number;
          def: string;
          seq: number;
        },
    );
    const firstSeq = new Map<string, number>();
    for (const r of rows)
      firstSeq.set(r.name, Math.min(firstSeq.get(r.name) ?? r.seq, r.seq));
    const latest = latestByVersion(rows.map((r) => ({ ...r, id: r.name })));
    latest.sort(
      (a, b) => (firstSeq.get(a.name) ?? 0) - (firstSeq.get(b.name) ?? 0),
    );
    return latest.map((r) => JSON.parse(r.def) as TypeDef);
  }
}
