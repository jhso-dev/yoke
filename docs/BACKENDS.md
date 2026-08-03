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
| storage-neo4j | **v5.2 (built)** | an enterprise already runs one, and it is the only backend with native FTS, vectors and graph in one engine |
| storage-postgres | v2.x | the leading default-backend candidate for server mode (v3) (pgvector doubles as similar) |

## Capability matrix

Corrected 2026-08-03: the kuzu row said `similar ✓` and kuzu has never implemented it —
`storage-kuzu/index.ts:5` cites *this table* as its justification for omitting the capability, so
the code pointed at a table that said the opposite. Its FTS row was also wrong in the other
direction: kuzu answers `search` app-level (materialize every row, tokenize, rank with
`core/rank.ts`), which is a real implementation with a real ceiling, not an absence.

| | FTS | similar | graph traversal | embedded |
|---|---|---|---|---|
| sqlite | ✓ (FTS5 bm25) | ✓ (sqlite-vec) | app-level | ✓ |
| kuzu | app-level | **—** | ✓ (native) | ✓ |
| qdrant | app-level | ✓ | — | — |
| **neo4j** | **✓ (native full-text index, scored)** | **✓ (native vector index)** | **✓ (native)** | — |
| postgres | ✓ | ✓ (pgvector) | app-level | — |

"app-level" is not a synonym for "absent": those adapters materialize candidates and rank them with
`core/rank.ts`'s BM25, which is why every backend can satisfy the same "best match first" conformance
case. It is a ceiling, and `docs/SCALE.md` is where the size of it is recorded.

The point at which `neighbors()`'s multi-hop traversal becomes a bottleneck is the
point at which we promote a graph capability into the port — not before.

## What a remote backend can and cannot implement (v5.2)

Discovered while building storage-neo4j, and it is the reason kuzu and qdrant were never reachable
from the CLI: `openStore` returns a **`YokeStore`**, and 10 of that interface's 12 extension methods
are **synchronous** — they were shaped by `better-sqlite3`, which is synchronous. A network-backed
store cannot implement a synchronous method. kuzu's own `saveOntology`/`loadOntology` are `async`,
which is exactly why kuzu does not satisfy `YokeStore`.

So a remote backend is composed rather than substituted (`storage-composite`), and the split is a
design decision, not a limitation to route around:

| | where | why |
|---|---|---|
| entities, relations, search, neighbors | **remote** | the knowledge itself. `StoragePort` is already fully async, so no interface change |
| ontology | **remote**, cached in memory at `init()` | a shared graph with per-client schemas means two people validating against different schemas |
| embedding vectors | **remote** | `similar` is meaningless anywhere other than beside the knowledge |
| audit log | **local sqlite** | the record of what THIS client was told. Centralising it is the v3.0 `serve --auth` story and needs 30 call sites to go async |
| API tokens | **local sqlite** | yoke's own credentials. They do not belong in the company's graph database, and asking would get a no |

Two interface methods had to become async because they touch remote rows: `renameType` (rewrites
entity rows) and `saveOntology` (writes remotely, and a synchronous fire-and-forget would lose the
error). `listHistory` stays optional and unimplemented on the composite — `core/lifecycle.ts`'s
`listVersions` already feature-detects it and falls back to walking `getEntity(id, version)`, which
is in the port and therefore async.

### Using it

```bash
export YOKE_NEO4J_URL=bolt://localhost:7687      # or neo4j+s://… for Aura
export YOKE_NEO4J_USER=neo4j
export YOKE_NEO4J_PASSWORD=…
export YOKE_NEO4J_DATABASE=neo4j                 # optional
yoke init                                        # creates constraints + indexes, seeds the ontology
```

`--db` still names the **local** sqlite that holds this client's audit trail and tokens; the knowledge
goes to Neo4j. Everything else is unchanged: `yoke add`, `review`, `verify`, `inject`, `yoke ui`, MCP.

For tests and for trying it:

```bash
docker run -d --rm --name yoke-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/testtest neo4j:5
```

The conformance suite runs against a real Neo4j when one is reachable and **skips when it is not**, so
`npm test` stays green without docker. CI runs it as a service container, so it is never only skipped.
A hand-written fake was rejected: faking Cypher means the fake encodes the same assumptions as the
adapter, and conformance against it would prove nothing — the qdrant adapter's REST fake is only
defensible because Qdrant's filter surface is a handful of JSON shapes, not a query language.

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

**Slack connector verified live (2026-07-14, real workspace channel)**: history +
thread replies ingested as draft facts, external_id idempotency, `--since`
scoping, and the review→verify→inject flow all confirmed. Two real-API fixes
came out of it: 429 rate-limit retry honoring Retry-After (a busy channel trips
the replies limit fast) and skipping `subtype` system events (join notices were
landing in the review queue as noise). Note: a full-history first sync of a
large channel is rate-limit-bound and slow by nature — scope with `--since`.
