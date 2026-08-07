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
| storage-opensearch | **v5.4 (built)** | an enterprise already runs one for logs and search, and it is a cheap adapter to own: a REST API, so `fetchImpl` injection makes it fakeable and it adds **no dependency** at all |
| storage-postgres | **v6.0 (built)** | the database most orgs already run; **no new dependency** (`pg` was already here for the RDB connector), native scored FTS, pgvector as `similar` when the extension is present |

A backend earns a place here by being **selectable** (`openStore` resolves it) and passing the shared
conformance suite against a real server. An adapter that only a `--shards` member entry could reach is
not a supported backend — that is a federation detail, not a way to run yoke.

## Capability matrix

| | FTS | similar | graph traversal | batch read | embedded |
|---|---|---|---|---|---|
| sqlite | ✓ (FTS5 bm25) | ✓ (sqlite-vec) | app-level | ✓ (`IN`) | ✓ |
| **opensearch** | **✓ (native BM25, scored)** | **✓ (native k-NN, HNSW)** | app-level (term query) | ✓ (`terms` + `latest`) | — |
| **postgres** | **✓ (native tsquery, `ts_rank`-scored)** | **✓ (pgvector, exact scan; absent without the extension)** | app-level | ✓ (`= ANY`) | — |

**Batch read** is `getEntities` (v5.5, SPEC "Batch point reads"), and it is the one column where an
*embedded* backend is right to have a dash: a point read there is a prepared statement, so omitting it
costs nothing and core's `getEntity` fallback covers it. On a remote backend the same loop was one
network round trip per id — a briefing of one collaboration cost 56 of them and now costs 2. sqlite
implements it anyway, because otherwise the conformance case would only ever run against a live server
and `npm test` would never execute the contract.

"app-level" is not a synonym for "absent": those adapters answer the same question out of ordinary
queries instead of a purpose-built index, which is why every backend satisfies the same conformance
cases. It is a ceiling, and `docs/SCALE.md` is where the size of it is recorded.

Every backend in the table ranks `search` with a native index, so `core/rank.ts`'s
`rankByRelevance`/`matchesTokens` — the BM25 an adapter without one needs — is called only by the
conformance suite's in-memory fake. It stays because the port declares "best match first" and postgres
is not the last backend; the fake is where that clause is checked with no engine's opinion in it.

Multi-hop is core's breadth-first loop over single-hop `neighbors()` on EVERY backend — the point
at which that becomes a bottleneck is the point at which we promote a graph capability into the
port — not before.

## What a remote backend can and cannot implement (v5.2)

`openStore` returns a **`YokeStore`**, and 8 of that
interface's 12 extension methods are **synchronous** — they were shaped by `better-sqlite3`, which is
synchronous. A network-backed store cannot implement a synchronous method, so an adapter whose
`loadOntology` has to be `async` does not satisfy `YokeStore` at all.

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
error). `listHistory` is **optional on the interface** and absent on the composite: it is synchronous and it
is about entity rows, which on a remote backend are across a network. Optional in the type, not only
in the caller's habits — so the composite `implements YokeStore` outright and the gap is checked
rather than cast away. `core/lifecycle.ts`'s `listVersions` feature-detects it and falls back to
walking `getEntity(id, version)`, which is in the port and therefore async.

### Using it

```bash
docker run -d --name yoke-opensearch -p 9200:9200 \
  -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
  -e DISABLE_INSTALL_DEMO_CONFIG=true -e "OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m" \
  opensearchproject/opensearch:2

export YOKE_OPENSEARCH_URL=http://localhost:9200
export YOKE_OPENSEARCH_USER=admin YOKE_OPENSEARCH_PASSWORD=...   # a secured cluster only
export YOKE_OPENSEARCH_PREFIX=team_a_                            # optional: two yoke DBs, one cluster
yoke init                                                        # creates the indices, seeds the ontology
```

The same exports work in a `.env` in the working directory (`cp .env.example .env`; SPEC
"Configuration precedence"). An actual environment variable overrides the file, so the export form
above still wins wherever both exist.

`--db` still names the **local** sqlite that holds this client's audit trail and tokens; the knowledge
goes to OpenSearch. Everything else is unchanged: `yoke add`, `review`, `verify`, `inject`, `yoke ui`,
MCP.

**The test suite is scoped by index prefix.** It creates and deletes `yoketest_*` indices only, so it
can run against the same cluster a demo is using — verified by running its whole suite — the 23 shared
conformance cases plus its own OpenSearch-specific ones — while a 1,007-document corpus sat in `yoke_*`,
and counting it unchanged afterwards. The isolation is a name, which is why the name is not negotiable.

> **`YOKE_TEST_OPENSEARCH_URL` names a cluster whose `yoketest_*` indices the suite DELETES**, in
> `beforeAll` — correct for a test index, destructive for anything else that answers to the prefix. So
> never widen the prefix, and never export the test variable in a shell you also run `yoke` from: a
> variable set once and forgotten is exactly the thing that must not be able to wipe a database on
> `npm test`, which is why the suite does not read `.env` either.

The conformance suite runs against a real OpenSearch when one is reachable and **skips when it is not**,
so `npm test` stays green without docker. CI runs it as a service container, so it is never only
skipped. A hand-written fake WOULD be defensible here — the query surface is a handful of JSON shapes
and the adapter takes a `fetchImpl` for exactly that — and the live suite still runs against a real
cluster on purpose: what it checks is the ENGINE's BM25 ranking, its analyzer's output, k-NN order and
near-real-time visibility, and a fake would encode the adapter's own beliefs about all four.

### Postgres

```bash
docker run -d --name yoke-pg -e POSTGRES_PASSWORD=... -p 5432:5432 pgvector/pgvector:pg17

export YOKE_POSTGRES_URL=postgres://postgres:...@localhost:5432/postgres
export YOKE_POSTGRES_SCHEMA=team_a               # optional: two yoke DBs in one database
yoke init                                        # creates the schema + tables, seeds the ontology
```

Same split: `--db` still names the local sqlite holding this client's audit trail and tokens; the
knowledge goes to Postgres. **No new dependency** — `pg` was already in the tree for the RDB
read-mapping connector.

Search is native and scored: core's own `tokenize`/`requireEveryTerm` build a prefix `tsquery`
(`simple` regconfig, so Hangul suffix tolerance holds — `parseArgs` reaches `parseArgs로`), ranked
with `ts_rank`, and the searchable `tsvector` lives only on each record's latest version. `similar`
is pgvector: when `CREATE EXTENSION vector` is unavailable the capability is genuinely **absent** —
`similar`/`putEmbedding` are not defined on the instance — so core's feature-detects behave exactly
as on any vectorless backend, and everything else still works.

**The test suite is scoped by schema.** It creates and drops `yoketest_*` schemas only, so it can run
against a database that is holding other things — the same isolation-by-name rule as the OpenSearch
suite, with the same warning: never point `YOKE_TEST_POSTGRES_URL` at a database whose `yoketest_*`
schemas you care about, and the suite does not read `.env` for exactly this reason. It skips without
a reachable server; CI runs it against two containers (pgvector and plain postgres, so the
no-extension path is never only skipped).

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
