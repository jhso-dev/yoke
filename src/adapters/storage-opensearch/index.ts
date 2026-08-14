// storage-opensearch — the OpenSearch implementation of StoragePort (v5.4).
//
// The remote backend, and a cheap one to own: OpenSearch speaks REST, so this takes a `fetchImpl` and
// adds **no dependency at all** — a backend speaking a binary protocol would have to ship a driver
// with it. Injectable fetch is also what makes it fakeable, so a company without a spare cluster is
// not locked out of the tests.
//
// Native BM25 and native k-NN, no native traversal: `neighbors` is a term query on from_id/to_id,
// which is what sqlite does too (docs/BACKENDS.md capability matrix). The k-NN plugin ships inside
// every OpenSearch distribution, unlike Elasticsearch where the equivalent moved in and out of the
// default build.
//
// Four policies here are decisions, not implementation details. Each one was measured against a real
// 2.19 server before it was written:
//
//  1. **Reads refresh before they read.** OpenSearch is near-real-time: a write is durable
//     immediately and *searchable* only after a refresh (~1s by default). Every conformance case
//     writes and then reads, so the port contract is read-your-writes. Refreshing on every write
//     (`?refresh=true`) forces a segment flush per document — the bounded-search case alone writes
//     1,005 of them. So writes mark their index dirty and the next READ refreshes once. Correct, and
//     one refresh instead of a thousand.
//  2. **`latest` is a stored flag, not a query-time collapse.** `listEntities` must return latest
//     versions only, in a total id order, through a cursor that cannot skip a row. `collapse` plus
//     `search_after` can approximate that, but a `status` filter would then match ANY version rather
//     than the one being returned. So `putEntity` sets `latest: true` and clears it on older versions
//     of the same id — the same shape as sqlite's FTS delete+insert.
//  3. **Prefix terms are required, exact terms are what score.** A `prefix` query is constant-score
//     in Lucene, so a query built only from prefixes ranks every hit identically and "best match
//     first" silently degrades to insertion order — the same defect a wildcard-only query has, and
//     easy to walk into. Required prefix clauses do the matching; optional `match` clauses rank.
//     Prefix matching is not optional here: measured against a real server, `match: "재시도"` returns
//     **0 hits** on text containing `재시도는`, because the standard analyzer keeps the particle
//     attached. Same reason sqlite quotes-and-stars every token.
//  4. **Vectors live in their own index, keyed by entity id.** Measured: with vectors on the entity
//     documents, a k-NN search for one record returned it twice, once per version. Keying by id makes
//     `putEmbedding` a derived-index write that creates no version and invalidates no citation
//     (SPEC "The vector index"), which is the same reason sqlite has `entity_vec`.
//
// ns is stored as "" for the default shared namespace rather than left absent: a missing field and a
// sentinel are different queries in OpenSearch, and `core/namespace.ts` already treats "" and null as
// the same namespace, so the sentinel needs no translation on the way in.

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

const ENTITIES = "yoke_entities";
const RELATIONS = "yoke_relations";
const ONTOLOGY = "yoke_ontology";
const VECTORS = "yoke_entity_vec";

/** Shared by every index: one shard, no replica. A single-node cluster cannot allocate a replica, and
 * a yellow cluster is a confusing thing to hand someone who is just trying the thing out. */
const BASE_SETTINGS = { number_of_shards: 1, number_of_replicas: 0 };

const ENTITY_MAPPING = {
  properties: {
    id: { type: "keyword" },
    version: { type: "integer" },
    type: { type: "keyword" },
    status: { type: "keyword" },
    ns: { type: "keyword" },
    latest: { type: "boolean" },
    // The analyzed field. `text` (not keyword) is what gives BM25 something to score.
    txt: { type: "text" },
    attributes: { type: "keyword", index: false },
    provenance: { type: "keyword", index: false },
    last_confirmed: { type: "keyword", index: false },
  },
} as const;

const RELATION_MAPPING = {
  properties: {
    id: { type: "keyword" },
    version: { type: "integer" },
    type: { type: "keyword" },
    status: { type: "keyword" },
    ns: { type: "keyword" },
    latest: { type: "boolean" },
    from_id: { type: "keyword" },
    to_id: { type: "keyword" },
    attributes: { type: "keyword", index: false },
    provenance: { type: "keyword", index: false },
    last_confirmed: { type: "keyword", index: false },
  },
} as const;

const ONTOLOGY_MAPPING = {
  properties: {
    name: { type: "keyword" },
    ns: { type: "keyword" },
    version: { type: "integer" },
    json: { type: "keyword", index: false },
  },
} as const;

interface Hit<T> {
  _id: string;
  _score: number;
  _source: T;
  sort?: unknown[];
}
interface SearchResponse<T> {
  hits: { hits: Hit<T>[] };
}

interface EntityDoc {
  id: string;
  version: number;
  type: string;
  status: string;
  ns: string;
  latest: boolean;
  txt?: string;
  attributes: string;
  provenance: string;
  last_confirmed: string;
}
interface RelationDoc extends Omit<EntityDoc, "txt"> {
  from_id: string;
  to_id: string;
}

export interface OpenSearchOptions {
  url: string;
  /** Basic-auth credentials. A security-enabled cluster wants them; a demo container does not. */
  username?: string;
  password?: string;
  /** Injected for tests — the same seam `web/lib/api.ts` and the slack connector use, and the reason
   * no dependency is needed to make this fakeable. */
  fetchImpl?: typeof fetch;
  /** Index name prefix, so two yoke databases can share one cluster. */
  prefix?: string;
}

export class OpenSearchStorage implements StoragePort {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly prefix: string;
  /** Indices written since the last refresh. See policy 1 in the file header. */
  private readonly dirty = new Set<string>();
  private vectorDim: number | null = null;

  constructor(opts: OpenSearchOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.prefix = opts.prefix ?? "";
    this.headers = { "content-type": "application/json" };
    if (opts.username !== undefined) {
      const basic = Buffer.from(
        `${opts.username}:${opts.password ?? ""}`,
      ).toString("base64");
      this.headers.authorization = `Basic ${basic}`;
    }
  }

  private idx(name: string): string {
    return `${this.prefix}${name}`;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 404 on a delete or a get is an absence, not a failure; every other status is real.
      if (res.status === 404) return (text ? JSON.parse(text) : {}) as T;
      throw new Error(
        `opensearch ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Create an index if absent. `init()` is the upgrade path for an existing cluster, so this is
   * idempotent the way sqlite's CREATE TABLE IF NOT EXISTS is. */
  private async ensureIndex(
    name: string,
    mappings: unknown,
    extraSettings?: Record<string, unknown>,
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/${name}`, {
      method: "HEAD",
      headers: this.headers,
    });
    if (res.ok) return;
    await this.req("PUT", `/${name}`, {
      settings: { ...BASE_SETTINGS, ...extraSettings },
      mappings,
    });
  }

  async init(): Promise<void> {
    await this.ensureIndex(this.idx(ENTITIES), ENTITY_MAPPING);
    await this.ensureIndex(this.idx(RELATIONS), RELATION_MAPPING);
    await this.ensureIndex(this.idx(ONTOLOGY), ONTOLOGY_MAPPING);
    // VECTORS is created lazily: its mapping declares the dimension, which is not known until the
    // first vector arrives. Same lazy shape as sqlite's vec0 table.
  }

  close(): void {
    // Nothing to release: fetch holds no connection of its own.
  }

  /** Make everything written so far visible to search. Called by reads, not by writes — see policy 1. */
  private async ready(...names: string[]): Promise<void> {
    const pending = names.filter((n) => this.dirty.has(n));
    if (pending.length === 0) return;
    await this.req("POST", `/${pending.join(",")}/_refresh`);
    for (const n of pending) this.dirty.delete(n);
  }

  private async index(
    name: string,
    docId: string,
    doc: unknown,
  ): Promise<void> {
    await this.req("PUT", `/${name}/_doc/${encodeURIComponent(docId)}`, doc);
    this.dirty.add(name);
  }

  /** Clear `latest` on every older version of this id. One call, and only when an older version can
   * exist — version 1 has nothing behind it. */
  private async demoteOlder(
    name: string,
    id: string,
    version: number,
  ): Promise<void> {
    if (version <= 1) return;
    await this.ready(name);
    await this.req("POST", `/${name}/_update_by_query?refresh=true`, {
      query: {
        bool: {
          filter: [
            { term: { id } },
            { range: { version: { lt: version } } },
            { term: { latest: true } },
          ],
        },
      },
      script: { source: "ctx._source.latest = false", lang: "painless" },
    });
  }

  async putEntity(e: Entity): Promise<void> {
    const doc: EntityDoc = {
      id: e.id,
      version: e.version,
      type: e.type,
      status: e.status,
      ns: normalizeNs(e.ns) ?? "",
      latest: true,
      txt: serializeText(e.type, JSON.stringify(e.attributes)),
      attributes: JSON.stringify(e.attributes),
      provenance: JSON.stringify(e.provenance),
      last_confirmed: e.last_confirmed,
    };
    // ceiling: index-then-demote is two requests with no transaction to join them — OpenSearch has
    // none — so a crash between leaves TWO docs flagged `latest: true` for one id until the next put
    // of that id heals it. The ORDER is the deliberate part: demote-then-index would fail the other
    // way, zero latest docs, a record every read silently loses. Duplication is visible and
    // self-healing; disappearance is neither. The way out, if a real deployment hits the window, is a
    // query-time collapse by max version — rejected so far because the stored flag is what lets
    // `listEntities` paginate without collapsing per page (see the header note).
    await this.index(this.idx(ENTITIES), `${e.id}#${e.version}`, doc);
    await this.demoteOlder(this.idx(ENTITIES), e.id, e.version);
    if (e.embedding) await this.indexEmbedding(e.id, e.embedding);
  }

  async putRelation(r: Relation): Promise<void> {
    const doc: RelationDoc = {
      id: r.id,
      version: r.version,
      type: r.type,
      status: r.status,
      ns: normalizeNs(r.ns) ?? "",
      latest: true,
      from_id: r.from,
      to_id: r.to,
      attributes: JSON.stringify(r.attributes),
      provenance: JSON.stringify(r.provenance),
      last_confirmed: r.last_confirmed,
    };
    await this.index(this.idx(RELATIONS), `${r.id}#${r.version}`, doc);
    await this.demoteOlder(this.idx(RELATIONS), r.id, r.version);
  }

  // --- vectors -------------------------------------------------------------------------------

  /** The declared dimension of the vector index, or null when no vector has ever been written. */
  private async readVectorDim(): Promise<number | null> {
    if (this.vectorDim !== null) return this.vectorDim;
    const name = this.idx(VECTORS);
    const res = await this.fetchImpl(`${this.url}/${name}/_mapping`, {
      method: "GET",
      headers: this.headers,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<
      string,
      {
        mappings?: {
          properties?: { embedding?: { dimension?: number } };
        };
      }
    >;
    const dim = body[name]?.mappings?.properties?.embedding?.dimension ?? null;
    this.vectorDim = dim;
    return dim;
  }

  private async ensureVectorIndex(dim: number, rebuild = false): Promise<void> {
    const name = this.idx(VECTORS);
    if (rebuild) {
      await this.req("DELETE", `/${name}`);
      this.vectorDim = null;
      this.dirty.delete(name);
    }
    const current = await this.readVectorDim();
    if (current !== null) {
      if (current !== dim) throw dimensionMismatch(current, dim, false);
      return;
    }
    await this.req("PUT", `/${name}`, {
      settings: { ...BASE_SETTINGS, "index.knn": true },
      mappings: {
        properties: {
          id: { type: "keyword" },
          ns: { type: "keyword" },
          embedding: {
            type: "knn_vector",
            dimension: dim,
            space_type: "cosinesimil",
            method: { name: "hnsw", engine: "lucene" },
          },
        },
      },
    });
    this.vectorDim = dim;
  }

  private async indexEmbedding(
    id: string,
    embedding: Float32Array,
    rebuild = false,
  ): Promise<void> {
    await this.ensureVectorIndex(embedding.length, rebuild);
    // Keyed by entity id, so re-embedding replaces rather than accumulates.
    await this.index(this.idx(VECTORS), id, {
      id,
      embedding: Array.from(embedding),
    });
  }

  async putEmbedding(e: Entity, opts?: { rebuild?: boolean }): Promise<void> {
    if (!e.embedding) return;
    await this.indexEmbedding(e.id, e.embedding, opts?.rebuild);
  }

  async similar(embedding: Float32Array, k: number): Promise<Entity[]> {
    const dim = await this.readVectorDim();
    if (dim === null) return [];
    if (dim !== embedding.length)
      throw dimensionMismatch(dim, embedding.length, true);
    await this.ready(this.idx(VECTORS));
    const res = await this.req<SearchResponse<{ id: string }>>(
      "POST",
      `/${this.idx(VECTORS)}/_search`,
      {
        size: k,
        query: { knn: { embedding: { vector: Array.from(embedding), k } } },
        _source: ["id"],
      },
    );
    // One batch read, NOT one per hit: `similar` is on the hybrid-retrieval path, so it runs on
    // every query injection with k = limit x 3 — the largest N+1 in the read paths (v5.5).
    // getEntities preserves the id order it is given, which is why score order survives.
    return this.getEntities(res.hits.hits.map((h) => h._source.id));
  }

  // --- reads ---------------------------------------------------------------------------------

  private toEntity(d: EntityDoc): Entity {
    return {
      id: d.id,
      type: d.type,
      version: d.version,
      status: d.status as Status,
      attributes: JSON.parse(d.attributes) as Record<string, unknown>,
      provenance: JSON.parse(d.provenance) as Provenance,
      last_confirmed: d.last_confirmed,
      ...(d.ns ? { ns: d.ns } : {}),
    };
  }

  private toRelation(d: RelationDoc): Relation {
    return {
      id: d.id,
      type: d.type,
      version: d.version,
      status: d.status as Status,
      attributes: JSON.parse(d.attributes) as Record<string, unknown>,
      provenance: JSON.parse(d.provenance) as Provenance,
      last_confirmed: d.last_confirmed,
      from: d.from_id,
      to: d.to_id,
      ...(d.ns ? { ns: d.ns } : {}),
    };
  }

  async getEntity(id: string, version?: number): Promise<Entity | null> {
    await this.ready(this.idx(ENTITIES));
    if (version !== undefined) {
      const res = await this.req<{ _source?: EntityDoc; found?: boolean }>(
        "GET",
        `/${this.idx(ENTITIES)}/_doc/${encodeURIComponent(`${id}#${version}`)}`,
      );
      return res._source ? this.toEntity(res._source) : null;
    }
    const res = await this.req<SearchResponse<EntityDoc>>(
      "POST",
      `/${this.idx(ENTITIES)}/_search`,
      {
        size: 1,
        query: { bool: { filter: [{ term: { id } }] } },
        sort: [{ version: "desc" }],
      },
    );
    const hit = res.hits.hits[0];
    return hit ? this.toEntity(hit._source) : null;
  }

  /** One edge by id — parity with the other adapters, so `get <relation-id>` resolves everywhere. */
  async getRelation(id: string, version?: number): Promise<Relation | null> {
    await this.ready(this.idx(RELATIONS));
    if (version !== undefined) {
      const res = await this.req<{ _source?: RelationDoc; found?: boolean }>(
        "GET",
        `/${this.idx(RELATIONS)}/_doc/${encodeURIComponent(`${id}#${version}`)}`,
      );
      return res._source ? this.toRelation(res._source) : null;
    }
    const res = await this.req<SearchResponse<RelationDoc>>(
      "POST",
      `/${this.idx(RELATIONS)}/_search`,
      {
        size: 1,
        query: { bool: { filter: [{ term: { id } }] } },
        sort: [{ version: "desc" }],
      },
    );
    const hit = res.hits.hits[0];
    return hit ? this.toRelation(hit._source) : null;
  }

  /** Batch point read (v5.5) — one search instead of one per id. The stored `latest` flag is what
   * makes it a single call: without it the query would have to sort per id, which a `terms` filter
   * cannot do. `size` is exactly the number asked for, since `latest` leaves one doc per id. */
  async getEntities(ids: string[]): Promise<Entity[]> {
    if (ids.length === 0) return [];
    await this.ready(this.idx(ENTITIES));
    const res = await this.req<SearchResponse<EntityDoc>>(
      "POST",
      `/${this.idx(ENTITIES)}/_search`,
      {
        size: ids.length,
        query: {
          bool: {
            filter: [{ terms: { id: ids } }, { term: { latest: true } }],
          },
        },
      },
    );
    return orderByIds(
      res.hits.hits.map((h) => this.toEntity(h._source)),
      ids,
    );
  }

  async neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]> {
    await this.ready(this.idx(RELATIONS));
    const ends =
      dir === "out"
        ? [{ term: { from_id: id } }]
        : dir === "in"
          ? [{ term: { to_id: id } }]
          : [{ term: { from_id: id } }, { term: { to_id: id } }];
    const filter: unknown[] = [{ term: { latest: true } }];
    if (relType !== undefined) filter.push({ term: { type: relType } });
    const res = await this.req<SearchResponse<RelationDoc>>(
      "POST",
      `/${this.idx(RELATIONS)}/_search`,
      {
        size: DEFAULT_SEARCH_LIMIT,
        query: {
          bool: { filter, should: ends, minimum_should_match: 1 },
        },
        sort: [{ id: "asc" }],
      },
    );
    return res.hits.hits.map((h) => this.toRelation(h._source));
  }

  async search(q: TextQuery): Promise<Entity[]> {
    const tokens = tokenize(q.text);
    if (tokens.length === 0) return [];
    await this.ready(this.idx(ENTITIES));
    // Required prefix clauses match; optional exact clauses score. See policy 3 — prefix queries are
    // constant-score, so on their own they rank every hit identically.
    //
    // Past AND_TERM_LIMIT tokens the prefix clauses move into `should` and one of them is enough
    // (SPEC search clause 8). `minimum_should_match` is set explicitly rather than left to the
    // must-less default, because that default has moved between Lucene versions and this adapter
    // targets every OpenSearch distribution.
    const prefixes = tokens.map((t) => ({ prefix: { txt: { value: t } } }));
    const exact = tokens.map((t) => ({ match: { txt: t } }));
    const loose = !requireEveryTerm(tokens.length, q.terms);
    const must = loose ? [] : prefixes;
    const should = loose ? [...prefixes, ...exact] : exact;
    const filter: unknown[] = [
      { term: { latest: true } },
      { term: { ns: normalizeNs(q.ns) ?? "" } },
    ];
    if (q.type !== undefined) filter.push({ term: { type: q.type } });
    if (q.status !== undefined) {
      filter.push(
        Array.isArray(q.status)
          ? { terms: { status: q.status } }
          : { term: { status: q.status } },
      );
    }
    const res = await this.req<SearchResponse<EntityDoc>>(
      "POST",
      `/${this.idx(ENTITIES)}/_search`,
      {
        size: q.limit ?? DEFAULT_SEARCH_LIMIT,
        query: {
          bool: { must, should, filter, minimum_should_match: loose ? 1 : 0 },
        },
        // Score first, then id — the tiebreak is what makes every backend agree on a total order.
        sort: [{ _score: "desc" }, { id: "asc" }],
      },
    );
    return res.hits.hits.map((h) => this.toEntity(h._source));
  }

  /** One keyset page of an index. `limit + 1` is over-read so `next` reflects a row that exists. */
  private async listPage<D extends { id: string }>(
    name: string,
    q: ListQuery,
    extraFilter: unknown[] = [],
  ): Promise<Hit<D>[]> {
    await this.ready(name);
    const filter: unknown[] = [
      { term: { latest: true } },
      { term: { ns: normalizeNs(q.ns) ?? "" } },
      ...extraFilter,
    ];
    if (q.type !== undefined) filter.push({ term: { type: q.type } });
    if (q.status !== undefined) filter.push({ term: { status: q.status } });
    if (q.after !== undefined) filter.push({ range: { id: { gt: q.after } } });
    // Enumeration is unbounded when the caller names no limit — the opposite default from search, on
    // purpose (SPEC "Enumeration"). 10k is OpenSearch's max window, so an unbounded walk pages.
    const wanted = q.limit === undefined ? undefined : q.limit + 1;
    const out: Hit<D>[] = [];
    let after: unknown[] | undefined;
    const PAGE = 5000;
    for (;;) {
      const size =
        wanted === undefined ? PAGE : Math.min(PAGE, wanted - out.length);
      if (size <= 0) break;
      const res = await this.req<SearchResponse<D>>(
        "POST",
        `/${name}/_search`,
        {
          size,
          query: { bool: { filter } },
          sort: [{ id: "asc" }],
          ...(after ? { search_after: after } : {}),
        },
      );
      const hits = res.hits.hits;
      out.push(...hits);
      if (hits.length < size) break;
      after = hits[hits.length - 1].sort;
      if (!after) break;
    }
    return out;
  }

  async listEntities(q: ListQuery): Promise<Page<Entity>> {
    const hits = await this.listPage<EntityDoc>(this.idx(ENTITIES), q);
    return page(
      hits.map((h) => this.toEntity(h._source)),
      q.limit,
    );
  }

  async listRelations(q: ListQuery): Promise<Page<Relation>> {
    const hits = await this.listPage<RelationDoc>(this.idx(RELATIONS), q);
    return page(
      hits.map((h) => this.toRelation(h._source)),
      q.limit,
    );
  }

  // --- ontology (async: the remote half of storage-composite) --------------------------------

  async saveOntology(defs: TypeDef[], ns?: string | null): Promise<void> {
    const name = this.idx(ONTOLOGY);
    const scope = normalizeNs(ns) ?? "";
    await this.ready(name);
    for (const def of defs) {
      // Append as the next version per name, matching sqlite's accumulate-don't-overwrite.
      const existing = await this.req<SearchResponse<{ version: number }>>(
        "POST",
        `/${name}/_search`,
        {
          size: 1,
          query: {
            bool: {
              filter: [{ term: { name: def.name } }, { term: { ns: scope } }],
            },
          },
          sort: [{ version: "desc" }],
        },
      );
      const version = (existing.hits.hits[0]?._source.version ?? 0) + 1;
      await this.index(name, `${scope}#${def.name}#${version}`, {
        name: def.name,
        ns: scope,
        version,
        json: JSON.stringify(def),
      });
      await this.ready(name);
    }
  }

  async loadOntology(ns?: string | null): Promise<TypeDef[]> {
    const name = this.idx(ONTOLOGY);
    const scope = normalizeNs(ns) ?? "";
    await this.ready(name);
    const res = await this.req<
      SearchResponse<{ name: string; version: number; json: string }>
    >("POST", `/${name}/_search`, {
      size: 10_000,
      query: { bool: { filter: [{ term: { ns: scope } }] } },
      sort: [{ version: "desc" }],
    });
    const latest = new Map<string, TypeDef>();
    for (const h of res.hits.hits) {
      if (!latest.has(h._source.name))
        latest.set(h._source.name, JSON.parse(h._source.json) as TypeDef);
    }
    return [...latest.values()];
  }

  /**
   * Rename an entity/relation type across the declaration and every stored row.
   *
   * Rewrites rather than appends, which is the only shape that answers the question — appending would
   * leave the old name in every historical row (ROADMAP v4.0 note). `txt` embeds the type name, so it
   * is rebuilt from the stored attributes rather than patched.
   */
  async renameType(
    from: string,
    to: string,
    ns?: string | null,
  ): Promise<number> {
    const scope = normalizeNs(ns) ?? "";
    let changed = 0;
    for (const name of [this.idx(ENTITIES), this.idx(RELATIONS)]) {
      await this.ready(name);
      const res = await this.req<{ updated?: number }>(
        "POST",
        `/${name}/_update_by_query?refresh=true`,
        {
          query: {
            bool: {
              filter: [{ term: { type: from } }, { term: { ns: scope } }],
            },
          },
          script: {
            lang: "painless",
            // txt only exists on entities; the guard keeps one script valid for both indices.
            source:
              "ctx._source.type = params.to; if (ctx._source.containsKey('txt') && ctx._source.txt != null) { ctx._source.txt = params.to + ' ' + ctx._source.attributes; }",
            params: { to },
          },
        },
      );
      changed += res.updated ?? 0;
    }
    const ont = this.idx(ONTOLOGY);
    await this.ready(ont);
    await this.req("POST", `/${ont}/_update_by_query?refresh=true`, {
      query: {
        bool: { filter: [{ term: { name: from } }, { term: { ns: scope } }] },
      },
      script: {
        lang: "painless",
        source:
          "ctx._source.name = params.to; ctx._source.json = ctx._source.json.replace('\"name\":\"' + params.from + '\"', '\"name\":\"' + params.to + '\"');",
        params: { from, to },
      },
    });
    return changed;
  }
}
