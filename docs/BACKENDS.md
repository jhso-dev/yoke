# yoke — Backends (v2.0 design)

The design direction for expanding storage port implementations and for
traditional-DB compatibility. Detailed when work starts (v2.0).

## Principles

- Every backend passes the same storage port + conformance suite (invariant 2).
- Backend-specific features are declared as optional capabilities (`similar`, etc.);
  core keeps a fallback.
- Adding a backend = one adapter directory + passing conformance. No core changes.
  If a core change becomes necessary, that's a port design flaw — fix the port first.

## Adapter roadmap

| Adapter | When | Why chosen |
|---|---|---|
| storage-sqlite | v0.1 | embedded; FTS5 + sqlite-vec cover all of v1 |
| storage-kuzu | v2.0 | embedded graph DB — stronger graph queries with no infrastructure. A proven path Cognee also adopted |
| storage-qdrant | v2.0 | a similar-capability-only implementation. Large-scale embeddings |
| storage-neo4j | v2.x | protecting an enterprise's existing Neo4j investment. After demand is confirmed |
| storage-postgres | v2.x | the leading default-backend candidate for server mode (v3) (pgvector doubles as similar) |

## Capability matrix (updated during design)

| | FTS | similar | graph traversal | embedded |
|---|---|---|---|---|
| sqlite | ✓ | ✓ (sqlite-vec) | app-level | ✓ |
| kuzu | — | ✓ | ✓ (native) | ✓ |
| qdrant | — | ✓ | — | — |
| postgres | ✓ | ✓ (pgvector) | app-level | — |

The point at which `neighbors()`'s multi-hop traversal becomes a bottleneck is the
point at which we promote a graph capability into the port — not before.

## Traditional-DB read-mapping (v2.0 — the enterprise wedge)

Expose an existing RDB as an ontology, with no migration. It's a **connector**, not
an adapter (a read-only entity source, not a storage port implementation).

- A mapping declaration file (yaml): tables/views → entity types, columns →
  attributes, FKs → relations. e.g. `employees` → `person`, `employees.manager_id`
  → `reports_to`.
- Mapped entities are treated as `status: verified` but distinguished by
  `provenance.origin: 'rdb:...'` — the source DB is already the org's source of
  truth, so draft isolation isn't needed. Freshness still applies, though (last sync
  time = last_confirmed).
- Read-only by principle. Bidirectional sync is designed separately if and when the
  need is real (conflict resolution is inherently hard — we don't add it casually).
- Target order: Postgres → MySQL. The rest by demand.
- **Verified live against Supabase Postgres (2026-07-14)**: initial sync,
  external_id idempotency, change detection (new version pair), FK relations,
  and injection all confirmed. Operational notes for Supabase specifically:
  `db.<ref>.supabase.co` is IPv6-only — on IPv4-only networks use the pooler
  host (`aws-0-<region>.pooler.supabase.com`, username `postgres.<ref>`);
  URL-encode special characters in the password; append `?sslmode=no-verify`
  (or provide certs) for pg's SSL handshake.

## Connector roadmap (the capture family)

github-pr (v0.5) → Slack, meeting notes (v2.0) → Confluence/Notion (by demand).
Shared pattern: external source → draft entity staging (unlike read-mapping, it
passes the gate).
