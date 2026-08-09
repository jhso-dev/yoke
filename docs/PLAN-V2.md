# yoke — v2.0 → v3.5 implementation plan

Extends PLAN.md beyond v1.0. Same global rules and autonomous-run protocol:
task = commit unit, all four checks green per commit, external services are
non-blocking (stub/fixture DoD + human-verification list), ROADMAP checkboxes
updated in the same commit. Design contracts live in BACKENDS.md, ENTERPRISE.md,
WEB-UI.md — on conflict, those win.

## v2.0 — backend expansion + RDB compatibility + audit

### 8.1 remote backend adapters

- `src/adapters/storage-opensearch/` (REST, no dep) implements the full
  StoragePort, composed with a local sqlite for the synchronous extension
  surface — see BACKENDS.md "What a remote backend can and cannot implement" and
  `storage-composite`. A Postgres adapter is the planned second, against the same
  shape.
- DoD: the shared conformance suite green against a real server for each, run in
  CI as a service container. No fake replaces the live run: the behaviour under
  test is the engine's.

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

### 9.2 screens, single static bundle

- `web/`: Next.js with `output: 'export'` → one static bundle served by the
  existing `node:http` server. Screen list and the three tests a new screen must
  pass: WEB-UI.md.
- Every knowledge row shows source/version (citation) — the audit-visible rule,
  enforced by `web/lib/citation-render.test.ts`.
- Delphi-style independence guard: the review queue does NOT show other
  reviewers' pending approvals (design hook for v3 multi-reviewer; note in code).
- DoD: vitest for API handlers (in-process) **plus a check that executes the
  shipped client bundle** — a substring assertion over HTML is not evidence that
  a UI works. Budgets replacing a line-count target: see the non-goals below.

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
  load pattern. ceiling: interval-pull snapshot replica; move to WAL shipping
  if staleness SLO ever demands it.
- Sharding: `--shards <config.json>` (v3.6), at the tenant boundary and
  entirely behind the storage port — see 12.1 below and ENTERPRISE.md.

## Non-goals (reject even if tempting)

**Express/Fastify** — the HTTP server is `node:http`. Next is a build tool here,
never a server, and `output: 'export'` is the mechanism that keeps that true.
**ORMs. yaml parsers. docker-compose test harnesses. WebSockets** — the graph
loads over `fetch`; there is no live push. **GraphQL** — the JSON API stays
route-per-question. **password auth** — browser login reuses a credential yoke
already mints (`yoke token create`) or an OIDC id_token; yoke never stores a
password. **per-field encryption.**

A build pipeline and React are allowed **for the web tier only**: Next.js with
`output: 'export'`, React, `d3-force`, and the shadcn/ui prerequisites below.
Nothing in `src/` gets a build step beyond `tsc`.

### Budgets

- **Shipped bundle ≤ 380 KB gzipped** (JS + CSS, whole static export), asserted by
  `src/front/ui/bundle.size.test.ts`, which stats the build output and skips when
  there is none. shadcn + Tailwind + Radix cost +117 KB (+52%) over the
  hand-written CSS it replaced, measured both ways before the number moved.
- **Dependency budget: `next`, `react`, `react-dom`, `d3-force`, plus the
  shadcn/ui prerequisites** — `tailwindcss`, `@tailwindcss/postcss`, `postcss`,
  `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`,
  `lucide-react`, `tw-animate-css`, and the type-only `typescript` / `@types/*`.
  Everything but `radix-ui` and `lucide-react` is build-time. **Anything further
  requires a note here first, naming what it buys.**

  What shadcn bought and cost: the hand-written CSS layer shrinks and the
  accessibility work in dialogs, selects and focus management stops being ours to
  get right; the bundle pays for it. `theme.css` maps this product's own tokens
  onto shadcn's names rather than taking the generated defaults — the
  terminal-adjacent look is deliberate, not a placeholder. One real loss: the
  create modal was a native `<dialog>` (focus trapping, Esc, inert background,
  `::backdrop`, all free) and Radix reimplements those in JS. That cost is paid
  for the components whose accessibility is genuinely hard to hand-roll.
- **No line-count budget.** There was one, twice; both numbers were invented
  rather than measured, both were blown, and nothing ever counted them — the
  ceiling only ever moved to wherever the code already was, which is a record of
  growth wearing a budget's clothes. What it was reaching for is covered better
  by two things that bite: the **bundle budget above**, asserted by a test, which
  measures what a user actually downloads; and WEB-UI.md's **three tests**, which
  is what stops screens multiplying — the real driver of size. A line count would
  not have refused a single screen either of those admits.
- **Zero new runtime deps in `src/front/ui/` and `src/front/serve/`**
  (`node:http` only), and **zero new listening ports**.
- **Zero web toolchain in the CLI install path** — a failed web build must
  still leave a working CLI.
- **A check that executes the shipped client bundle**, not one that greps the
  HTML for markers.
>
> The v5.0 task list lives in the plan file for that run; this document remains
> the v2.0→v3.6 record and is not retrofitted.

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
  path, namespaces: [..], default?: true }] }` — `kind` is `sqlite` only. A namespace routes to
  the shard listing it; unlisted/null ns routes to the default shard.
- Routing: writes (putEntity/putRelation) route by the row's ns. Point reads
  (getEntity, neighbors) fan out to all shards (ids are globally unique
  ULIDs; first hit wins / merge). search: ns-scoped → owner shard only;
  un-scoped → fan-out + merge + post-merge limit. similar: fan out to
  capable shards, re-rank merged hits by cosine to the query vector, slice k.
- Extension methods (listByStatus/listByActor/listHistory/logAudit/ontology):
  delegate to members that implement them; ns-scoped calls go to the owner
  shard. Ontology: shared (null-ns) defs live on the DEFAULT shard, tenant defs on the
  owner shard, and a namespaced read overlays the two — reading the owner shard alone
  would make every namespace owned by a non-default shard unusable, since `yoke init`
  seeds the shared base and a tenant shard never holds a copy. Audit is written
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
