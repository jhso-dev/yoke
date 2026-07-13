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
import type { TypeDef } from "../../core/ontology.js";
import type { Entity, Relation } from "../../core/types.js";
import type { StoragePort, TextQuery } from "../../ports/storage.js";

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

// Lowercase, split on any run of non-letter/non-number chars (unicode-aware). Hangul are letters,
// so "parseArgs로" stays one token while JSON punctuation separates — see kuzu adapter / case 6b.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
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
}
interface RelationPayload extends EntityPayload {
  from_id: string;
  to_id: string;
}

function payloadToEntity(p: EntityPayload): Entity {
  return {
    id: p.id,
    version: p.version,
    type: p.type,
    status: p.status as Entity["status"],
    attributes: JSON.parse(p.attributes),
    provenance: JSON.parse(p.provenance),
    last_confirmed: p.last_confirmed,
  };
}

function payloadToRelation(p: RelationPayload): Relation {
  return { ...payloadToEntity(p), from: p.from_id, to: p.to_id };
}

// Qdrant filter DSL — only the fragments this adapter relies on. The fake must honor these.
type Match = { key: string; match: { value: string | number } };
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

  private async ensureVectorCollection(dim: number): Promise<void> {
    if (this.vectorDim !== null) return;
    // ponytail: dimension pinned to the first embedding (same as sqlite). A provider with a
    // different dim needs the entity_vectors collection rebuilt.
    if (!(await this.collectionExists(ENTITY_VECTORS))) {
      await this.req("PUT", `/collections/${ENTITY_VECTORS}`, {
        vectors: { size: dim, distance: "Cosine" },
      });
    }
    this.vectorDim = dim;
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
    };
    await this.req("PUT", `/collections/${ENTITIES}/points`, {
      points: [{ id: pointId(`${e.id}#${e.version}`), payload }],
    });
    // Keep only the latest version's vector: one point per entity id (re-upsert overwrites).
    // Touched only when an embedding is present — a versionless re-put leaves the old vector,
    // same as sqlite (payload has no vector to reconstruct from).
    if (e.embedding) {
      await this.ensureVectorCollection(e.embedding.length);
      await this.req("PUT", `/collections/${ENTITY_VECTORS}/points`, {
        points: [
          {
            id: pointId(e.id),
            payload: { id: e.id },
            vector: Array.from(e.embedding),
          },
        ],
      });
    }
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
      from_id: r.from,
      to_id: r.to,
    };
    await this.req("PUT", `/collections/${RELATIONS}/points`, {
      points: [{ id: pointId(`${r.id}#${r.version}`), payload }],
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
    const matched = rows.filter((r) => {
      const eTokens = tokenize(r.txt);
      return qTokens.every((qt) => eTokens.some((et) => et.startsWith(qt)));
    });
    const filtered = matched.filter(
      (r) =>
        (q.type === undefined || r.type === q.type) &&
        (q.status === undefined || r.status === q.status),
    );
    return (q.limit === undefined ? filtered : filtered.slice(0, q.limit)).map(
      payloadToEntity,
    );
  }

  /** KNN over latest-version entities. Empty when no embedding was ever stored (no vector collection).
   * Restores each hit's .embedding (the gate applies the cosine threshold). */
  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    if (this.vectorDim === null) return [];
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
    const out: Entity[] = [];
    for (const hit of res.result) {
      const e = await this.getEntity(hit.payload.id);
      if (!e) continue;
      out.push(
        hit.vector ? { ...e, embedding: Float32Array.from(hit.vector) } : e,
      );
    }
    return out;
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
