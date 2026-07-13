# yoke — v2.0 → v3.5 implementation plan

Extends PLAN.md beyond v1.0. Same global rules and autonomous-run protocol:
task = commit unit, all four checks green per commit, external services are
non-blocking (stub/fixture DoD + human-verification list), ROADMAP checkboxes
updated in the same commit. Design contracts live in BACKENDS.md, ENTERPRISE.md,
WEB-UI.md — on conflict, those win.

## v2.0 — backend expansion + RDB compatibility + audit

### 8.1 storage-kuzu adapter

- deps allowed: `kuzu` (embedded graph DB, no server).
- `src/adapters/storage-kuzu/` implementing the full StoragePort via Cypher.
  Append-only versioned nodes/edges mirror the sqlite semantics. `search` is
  required by the port: implement app-level (CONTAINS-style scan over the
  serialized text with prefix tolerance) — Kuzu has no FTS5; the conformance
  suite is the contract, not the engine feature.
- `similar` omitted (capability absent). Ontology save/load mirrors sqlite
  extension methods.
- DoD: full conformance suite green against kuzu (both in-memory and on-disk
  if supported), plus existing suites untouched.

### 8.2 storage-qdrant adapter

- No new heavy SDK — REST via fetch. dep allowed: none.
- `src/adapters/storage-qdrant/` implementing StoragePort against Qdrant's
  REST API: points upsert (payload = entity JSON, vector = embedding),
  `similar` via vector search, `search` via payload full-text match filter.
- Constructor takes `{ url, apiKey?, fetchImpl? }` — tests use a determinstic
  in-memory fake of the REST surface via fetchImpl (fixture-level), NOT a live
  server. Conformance runs against the fake-backed adapter.
- Human-verification list: run conformance against a real Qdrant once
  (`QDRANT_URL=... npm test` gate or a script).

### 8.3 RDB read-mapping connector (the enterprise wedge)

- `src/connectors/rdb-mapping.ts`: YAML-less mapping (JSON file — do not add a
  yaml dep): `{ table, entityType, columns: {col: attr}, idColumn,
  relations?: [{fkColumn, relType, toIdPrefix?}] }[]`.
- Driver-agnostic: connector takes `query(sql) => rows` function. Ship a
  Postgres impl using dep `pg` behind `yoke connect rdb --dsn ... --mapping
  file.json`; tests inject a sqlite-backed query fn (standard SQL subset).
- Mapped entities are read-only, `status: verified`, `provenance.origin:
  'rdb:<table>'`, `last_confirmed` = sync time; loaded via the commit gate?
  NO — BACKENDS.md: the source DB is already the org's system of record, so
  read-mapping bypasses draft staging BUT still validates against the ontology
  (gate steps 1 only). Implement as a distinct `ingestMapped()` that documents
  this exception. external_id = `rdb:<table>:<pk>` idempotency, re-sync = new
  version when values changed, skip when identical.

### 8.4 audit log

- No new table for history (append-only rows already are the audit log).
- New adapter extension `listHistory(id): Entity[]` (all versions) + CLI
  `yoke history <id>`.
- Injection audit: front layers (CLI inject, MCP tools) append to `audit_log`
  table via adapter extension `logAudit(event)` — records actor, query, ids
  injected, timestamp. CLI `yoke audit [--since]`. Core stays pure (logging is
  I/O at the front tier).

### 8.5 capture connectors: Slack + meeting notes

- `src/connectors/slack.ts`: conversations.history via fetch + token, maps
  messages with decision-ish markers (thread replies included) to draft
  `fact`/`decision`. Same Connector contract + external_id (message permalink).
  Tests: fetchImpl fixtures. Human list: live token run.
- `src/connectors/meeting-notes.ts`: local .txt/.md transcript files → draft
  facts (one per bullet/section heuristic — keep dumb). external_id =
  `file:<path>#<n>`.
- CLI: `yoke connect slack --channel C123 [--since]`, `yoke connect notes <dir>`.

## v2.5 — web UI (governance workbench)

### 9.1 embedded server + API

- `yoke ui [--port 4800]`: node:http only, NO express. JSON API exposing
  existing core/adapter functions: GET /api/review, /api/conflicts,
  /api/ontology, /api/persona/:id, POST /api/verify, /api/deprecate.
  Every action must remain CLI-achievable (WEB-UI.md rule).

### 9.2 four screens, single static bundle

- One `index.html` (vanilla JS + fetch, no framework, no build step) served
  from `src/front/ui/static/`: Review queue (bulk verify/reject),
  Conflicts view (side-by-side, deprecate one side), Ontology browser
  (types + TTLs), Persona preview (person → would-be injection list + export).
- Every knowledge row shows source/version (citation) — audit-visible rule.
- Delphi-style independence guard: the review queue does NOT show other
  reviewers' pending approvals (design hook for v3 multi-reviewer; note in code).
- DoD: vitest for API handlers (in-process), manual screenshot via `yoke ui`
  optional. Keep total UI code small (<600 lines target).

## v3.0 — enterprise (multi-tenancy, auth, RBAC)

### 10.1 namespaces (logical multi-tenancy)

- Namespace = id prefix `ns/` (opaque-id constraint honored: only the
  namespace module parses it; everywhere else ids stay opaque).
- `namespace` column added to entities/relations (nullable = default ns),
  adapter migration on init. All list/search/inject paths take an optional
  namespace filter threaded from front (env YOKE_NS / --ns / token scope).
- Tenant ontology: ontology_types gains namespace column; lookup = tenant defs
  overlay shared (null-ns) defs.

### 10.2 server mode

- `yoke serve [--port]`: the UI server + a remote MCP endpoint (SDK streamable
  HTTP transport) + the JSON API, all on one port. stdio `yoke mcp` remains.

### 10.3 auth: API tokens + OIDC

- API tokens: `yoke token create --scopes ns:read,ns:write,ns:verify` →
  random secret, salted-hash stored in a `tokens` table (adapter extension).
  Bearer auth middleware on serve mode.
- OIDC: verify RS256 JWTs via JWKS (dep allowed: `jose`). Config env
  YOKE_OIDC_ISSUER/AUDIENCE. Subject maps to a person entity
  (auto-provision person on first login, gate-committed, verified).
  Tests: self-signed JWKS fixtures via jose. Human list: real IdP run.

### 10.4 RBAC

- Axes: namespace × entity-type × action(read|write|verify). Deny by default
  when serve-mode auth is on; local CLI (no server) stays ungated (single-user
  mode unchanged — do not break v1 UX).
- Enforcement lives in the serve-mode middleware, not core. Agents' tokens
  default to write-only (no verify) — the governance rule, now enforced.

## v3.5 — durability

### 11.1 backup / restore / PITR

- `yoke backup <dest.db>` (better-sqlite3 `.backup()` — online, WAL-safe),
  `yoke restore <src.db>`, and PITR-lite: because history is append-only,
  `yoke export --until <ts>` reconstructs a DB as of a timestamp into a new
  file (replay latest-version-at-ts). Tests: backup→restore round-trip,
  export-at-ts excludes later versions.

### 11.2 read replicas

- `yoke serve --replica-of <path|url>`: serves reads from a local snapshot
  refreshed by interval `.backup()` pull; writes rejected with a clear error
  pointing at the primary. Injection is read-dominant, so this covers the real
  load pattern. ponytail: interval-pull snapshot replica; move to WAL shipping
  if staleness SLO ever demands it.
- Sharding: NOT implemented (by design — ROADMAP defers until measured need).
  Add a one-paragraph note in ENTERPRISE.md marking tenant-boundary sharding
  as the natural cut when it comes.

## Non-goals for this whole run (reject even if tempting)

Express/Fastify, React/Vue/build pipelines, ORMs, yaml parsers, docker-compose
test harnesses, WebSockets, GraphQL, password auth, per-field encryption.

## Order

8.1 → 8.2 → 8.3 → 8.4 → 8.5 → 9.x → 10.1 → 10.2 → 10.3 → 10.4 → 11.x
(8.x tasks are independent of each other after 8.1's conformance touch-ups,
so 8.2/8.3/8.5 may run in parallel; 9.x needs 8.4's audit extensions;
10.x is strictly sequential; 11.x last.)

## v3.6 — sharding + multi-backend federation

### 12.1 sharded composite storage

- src/adapters/storage-sharded/: `ShardedStorage implements StoragePort`,
  composing member StoragePorts. Core untouched — sharding lives entirely
  behind the port (the ARCHITECTURE bet paying off).
- Shard config (JSON): `{ shards: [{ name, kind: sqlite|kuzu|qdrant,
  path?|url?, namespaces: [..], default?: true }] }`. A namespace routes to
  the shard listing it; unlisted/null ns routes to the default shard.
- Routing: writes (putEntity/putRelation) route by the row's ns. Point reads
  (getEntity, neighbors) fan out to all shards (ids are globally unique
  ULIDs; first hit wins / merge). search: ns-scoped → owner shard only;
  un-scoped → fan-out + merge + post-merge limit. similar: fan out to
  capable shards, re-rank merged hits by cosine to the query vector, slice k.
- Extension methods (listByStatus/listByActor/listHistory/logAudit/ontology):
  delegate to members that implement them; ns-scoped calls go to the owner
  shard. Ontology lives per shard (owner shard's overlay). Audit is written
  to the shard that served the write. Ceilings documented.
- Duplicate/contradiction detection stays intra-shard (a tenant's knowledge
  dedups against itself — cross-tenant dedup would be a data leak, so this
  is correct, not just lazy).

### 12.2 config + front threading

- `--shards <config.json>` accepted wherever `--db` is (CLI commands, mcp,
  ui, serve). `--db` remains the single-backend fast path. Loader validates
  config (exactly one default shard, no ns claimed twice).
- Conformance: ShardedStorage(single sqlite member) passes the full suite;
  plus routed tests (two sqlite members: ns isolation across shards,
  fan-out getEntity, merged un-scoped search, per-shard ontology).
