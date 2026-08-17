// backstage connector (v7.3.3). A Backstage catalog → `service`/`api`/`datastore` records, `owns` edges
// against v7.2's groups, `depends_on` edges, and TechDocs links as `resource` records.
//
// The answer to "yoke has no catalog" is not to build one. An organisation running Backstage already
// maintains its descriptors, and a second catalog kept by hand is the two-places-to-update problem that
// makes catalogs rot in the first place (WEB-UI.md's amended test 1 forbids the authoring surface one
// would need). This reads what is already there.
//
// **Rows land verified**, under the documented `connect rdb` exception (BACKENDS.md): the catalog is
// already the organisation's system of record for what it runs, so this follows `ingestMapped`'s shape
// rather than `ingest`'s draft contract. One deliberate difference from that exception, and it is the
// reason this is worth building rather than mirroring: the catalog types carry a TTL
// (ontology/catalog.json), so a service record ages and appears in `yoke review --stale` addressed to its
// owner. Catalog decay becomes a queue item instead of a silent lie.
//
// The catalog API, not `catalog-info.yaml` by glob. The API IS those descriptors, aggregated and
// resolved, and it needs no YAML parser — which would be this repo's first dependency for a format it
// otherwise never reads. An org with descriptors but no Backstage is the case this does not serve: a
// deliberate gap, stated rather than discovered.
//
// Single-write-path invariant preserved: never `putEntity`. Every row is `commit()` (draft) then
// `verify()`, the same two steps `ingestMapped` and `cmdInit` use.

import { commit } from "../core/commit.js";
import type { Embedder } from "../core/embedding.js";
import { verify } from "../core/lifecycle.js";
import type { TypeDef } from "../core/ontology.js";
import type { StoragePort } from "../ports/storage.js";

/** How many catalog entities one request asks for. */
const PAGE = 100;

/** Backstage kinds this maps, and the yoke type each becomes. Anything else is skipped. */
const KIND_MAP: Record<string, string> = {
  component: "service",
  api: "api",
  resource: "datastore",
};

interface BackstageEntity {
  kind?: string;
  metadata?: {
    name?: string;
    title?: string;
    description?: string;
    annotations?: Record<string, string>;
  };
  spec?: { lifecycle?: string; owner?: string; dependsOn?: string[] };
}

/** One catalog row, already in yoke's vocabulary. */
export interface CatalogItem {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  /** Group or person id accountable for it, from `spec.owner`. */
  owner?: string;
  /** Ids this depends on, from `spec.dependsOn`. */
  dependsOn: string[];
  /** A TechDocs link, filed as its own `resource` record so the docs index can reach it. */
  docs?: { id: string; url: string; title: string };
}

export interface BackstageCatalog {
  name: string;
  items(): AsyncIterable<CatalogItem>;
}

/**
 * A Backstage entity reference (`group:default/platform`, `component:api`) → a yoke id.
 *
 * The kind prefix is kept, so a `component` and a `group` of the same name are two records rather than
 * one collision. The Backstage namespace (`default/`) is dropped: that is Backstage's tenancy, and yoke
 * has its own (`--ns`), so carrying both into one id would encode a tenant boundary inside a key.
 */
export function refToId(ref: string): string {
  const [kindPart, rest] = ref.includes(":")
    ? (ref.split(":", 2) as [string, string])
    : ["component", ref];
  const name = rest.includes("/") ? rest.split("/").pop() : rest;
  const kind = kindPart.toLowerCase();
  const slug = (name ?? "").toLowerCase();
  // `group:`/`user:` map onto v7.2's ids so `owns` lands on the same record the IdP sync mirrors, rather
  // than minting a parallel org chart nobody joins to.
  if (kind === "group") return `group:${slug}`;
  if (kind === "user") return `person:${slug}`;
  return `${KIND_MAP[kind] ?? kind}:${slug}`;
}

/** Backstage catalog API → catalog items. */
export function makeBackstageConnector(opts: {
  url: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): BackstageCatalog {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const root = opts.url.replace(/\/$/, "");

  async function* raw(): AsyncIterable<BackstageEntity> {
    for (let offset = 0; ; offset += PAGE) {
      const url = `${root}/api/catalog/entities?${new URLSearchParams({
        limit: String(PAGE),
        offset: String(offset),
      })}`;
      const res = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
      });
      if (!res.ok)
        throw new Error(
          `backstage catalog failed (${res.status}): ${await res.text()}`,
        );
      const body = (await res.json()) as
        | BackstageEntity[]
        | { items?: BackstageEntity[] };
      // Older backends answer with a bare array, newer ones with `{items}`. Both, because a connector
      // that reads one shape reports "0 imported" against the other and looks like an empty catalog.
      const page = Array.isArray(body) ? body : (body.items ?? []);
      for (const e of page) yield e;
      if (page.length < PAGE) return;
    }
  }

  return {
    name: "backstage",
    async *items(): AsyncIterable<CatalogItem> {
      for await (const e of raw()) {
        const kind = (e.kind ?? "").toLowerCase();
        const type = KIND_MAP[kind];
        const name = e.metadata?.name;
        if (!type || !name) continue;
        const id = `${type}:${name.toLowerCase()}`;
        const annotations = e.metadata?.annotations ?? {};
        const techdocs = annotations["backstage.io/techdocs-ref"];
        yield {
          id,
          type,
          attributes: {
            name: e.metadata?.title || name,
            ...(e.metadata?.description
              ? { description: e.metadata.description }
              : {}),
            ...(e.spec?.lifecycle ? { lifecycle: e.spec.lifecycle } : {}),
            // Where the code is, which is what makes a service row actionable.
            ...(annotations["backstage.io/source-location"]
              ? { repo: annotations["backstage.io/source-location"] }
              : {}),
            external_id: `backstage:${kind}/${name}`,
          },
          owner: e.spec?.owner ? refToId(e.spec.owner) : undefined,
          dependsOn: (e.spec?.dependsOn ?? []).map(refToId),
          docs: techdocs
            ? {
                id: `resource:docs-${name.toLowerCase()}`,
                url: techdocs,
                title: `${e.metadata?.title || name} docs`,
              }
            : undefined,
        };
      }
    },
  };
}

export interface CatalogResult {
  entities: number;
  edges: number;
  docs: number;
  errors: number;
}

/**
 * Import a catalog as verified records and edges.
 *
 * Two passes for the reason `ingestMapped` has two: an edge's endpoints must exist before it is filed, and
 * a catalog names dependencies in both directions, so a single pass would refuse every forward reference.
 *
 * Re-import re-versions rather than duplicating (`existingId`), which is what makes this safe to put on a
 * schedule — and a scheduled re-sync is also what keeps the records inside their TTL, so a catalog nobody
 * syncs is a catalog that goes stale in the queue. Both halves are the intended design.
 */
export async function ingestCatalog(
  port: StoragePort,
  ontology: TypeDef[],
  catalog: BackstageCatalog,
  now: string,
  ns?: string | null,
  embedder?: Embedder,
): Promise<CatalogResult> {
  const out: CatalogResult = { entities: 0, edges: 0, docs: 0, errors: 0 };
  const prov = { actor: "backstage", origin: "backstage", occurred_at: now };
  const items: CatalogItem[] = [];
  /** Ids this import has stored, so pass 2 can tell a forward reference from a dangling one. */
  const present = new Set<string>();

  const store = async (
    id: string,
    type: string,
    attributes: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await commit(port, ontology, { type, attributes }, prov, now, {
        existingId: id,
        ns,
        embedder,
      });
      // Verified for the reason in the file header. Promotion is a second step because the gate is the
      // only write path — reaching `verified` any other way would be a second one.
      await verify(port, [id], "backstage", now, ns);
      present.add(id);
      return true;
    } catch (e) {
      console.error(`backstage: ${id} not imported: ${(e as Error).message}`);
      out.errors++;
      return false;
    }
  };

  for await (const item of catalog.items()) {
    items.push(item);
    if (await store(item.id, item.type, item.attributes)) out.entities++;
    if (item.docs) {
      // TechDocs as a `resource`, so the docs index (v7.4.1) reaches it through the same filter as every
      // other document rather than through a field only the catalog screen knows about.
      const ok = await store(item.docs.id, "resource", {
        title: item.docs.title,
        url: item.docs.url,
        external_id: `backstage:techdocs/${item.id}`,
      });
      if (ok) out.docs++;
    }
  }

  for (const item of items) {
    const edges: { type: string; from: string; to: string }[] = [
      ...(item.owner ? [{ type: "owns", from: item.owner, to: item.id }] : []),
      ...item.dependsOn.map((to) => ({
        type: "depends_on",
        from: item.id,
        to,
      })),
      ...(item.docs
        ? [{ type: "relates_to", from: item.docs.id, to: item.id }]
        : []),
    ];
    for (const edge of edges) {
      // An owner group that no IdP sync has mirrored yet, or a dependency on something outside the
      // catalog, is a dangling endpoint. `derived: true` files it anyway for the same reason the gate's
      // own bookkeeping edges do: the alternative is dropping the accountability edge that makes the
      // portal answer "who do I ask", and an edge to a record that appears next sync is recoverable
      // where a silently skipped one is not.
      try {
        const rel = await commit(
          port,
          ontology,
          { type: edge.type, attributes: {}, from: edge.from, to: edge.to },
          prov,
          now,
          { ns, embedder, derived: true },
        );
        if (!rel.existed) out.edges++;
      } catch (e) {
        console.error(
          `backstage: edge ${edge.type} ${edge.from} -> ${edge.to} not filed: ${(e as Error).message}`,
        );
        out.errors++;
      }
    }
  }
  return out;
}
