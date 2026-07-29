# yoke — Roadmap (full-implementation basis)

Development proceeds in version order. Each version ends in a shippable state.
We don't implement a higher version's items early in a lower one — though we do
keep the design from blocking them (accepting an ID namespace, declaring storage
port capabilities, etc. See SPEC).

## v0.1 — core model + SQLite + gate

- [x] Project setup (TypeScript, better-sqlite3, vitest, biome)
- [x] Entity/Relation types + ontology-record model (SPEC-compliant)
- [x] storage port interface + conformance test suite skeleton
- [x] storage-sqlite adapter (append-only version rows, FTS5)
- [x] commit gate stages 1 & 2 (ontology validation, provenance validation)
- [x] Base ontology seed (person/fact/decision/term/resource)
- [x] CLI: `init` / `add` / `get` / `search`

## v0.2 — lifecycle + injection

- [x] Status transition logic (draft→verified→stale/deprecated)
- [x] `inject()` — verified-by-default filter + read-time freshness (TTL)
- [x] Citation-format output (source included)
- [x] CLI: `review` / `verify <id...>` (bulk)

## v0.3 — MCP server

- [x] MCP stdio server (`yoke mcp`)
- [x] Tools: `yoke_inject` / `yoke_commit` / `yoke_record_decision`
- [x] Claude Code real-use verification (success criterion: knowledge injection confirmed from another session)

## v0.4 — duplicates + contradictions

- [x] Embedding provider config (FTS fallback when unset)
- [x] sqlite-vec integration, storage port `similar` capability
- [x] Gate stages 3 & 4 (duplicate-candidate suggestion, conflicts_with creation)
- [x] CLI: `conflicts`

## v0.5 — capture connectors

- [x] Shared connector pattern (external source → draft entity staging)
- [x] github-pr connector (PR review comments → draft decision)
- [x] CLI: `connect github-pr`

## v0.6 — persona

- [x] Person-scoped query (provenance + relation traversal)
- [x] SKILL.md export (`yoke persona <person>`)
- [x] MCP tool: `yoke_persona`

## v1.0 — quality + packaging

- [x] Conformance suite completed + CI
- [x] Injection-quality eval (contamination rate, missed-contradiction rate) — MARKET strategy 6
- [x] npm packaging (`npx yoke`), README, onboarding docs

## v2.0 — backend expansion + traditional-DB compatibility

- [x] Graph DB adapter (KuzuDB embedded first, Neo4j next) — passes conformance
- [x] Vector DB adapter (Qdrant) — a similar-capability implementation
- [x] **RDB read-mapping**: Postgres/MySQL tables → read-only entity mapping
      (a table-to-ontology mapping declaration file; the enterprise wedge — MARKET strategy 3)
- [x] Audit log (a query API over the immutable record of gate/promotion/injection)
- [x] More connectors: Slack, meeting notes

## v2.5 — web UI

- [x] review/verify dashboard (draft queue, bulk promotion)
- [x] conflicts view (compare and resolve contradiction pairs)
- [x] ontology browser (visualize types and relations)
- [x] persona preview

> Note (2026-07-29): the JSON API behind these four screens shipped and is covered by
> tests, but **the shipped client script never parsed** — an unterminated string literal
> in `src/front/ui/static/index.html.ts` made the whole `<script>` block a SyntaxError, so
> no tab switched and no row loaded in a browser. `ui.test.ts` asserted HTML substrings
> only, so CI stayed green. The boxes stay checked for the API surface they name; the
> browser half is carried into v5.0 as an explicit deliverable rather than quietly
> rewritten here. Lesson recorded in the v5.0 DoD: a substring assertion is never
> evidence that a UI works.

## v3.0 — enterprise (multi-tenancy, auth)

- [x] Server mode (remote access: HTTP + MCP remote)
- [x] auth: OIDC/SSO integration, API tokens
- [x] RBAC: per-ontology-type/namespace permissions (read/write/promote separated —
      the verify permission *is* the knowledge-governance permission)
- [x] Multi-tenancy: namespace isolation (accommodated by the v0.1 ID scheme)
- [x] Per-tenant ontology + shared-ontology inheritance

## v3.5 — distribution + HA

- [x] Replication (read replicas — injection is read-dominated)
- [x] Backup/restore, PITR (built on the append-only history)
- [x] Sharding — tenant-boundary shards + multi-backend federation (--shards, v3.6)

## v4.0 — shared working context

- [x] Entity-scoped injection: `inject(scope: <entity-id>)` — verified knowledge
      within one relation hop of any entity (the generic mechanism; persona is
      the person-shaped instance of the same idea)
- [x] `workstream` seed entity type + `works_on` relation — a unit of
      collaborative work that groups people and knowledge for its duration
      (orgs can define their own equivalents in their ontology: epic,
      initiative, experiment, …)
- [x] Capture-side linking: `record_decision`/`commit` accept an optional
      scope entity to attach the new knowledge to (relates_to)
- [x] Declaration-based scope: the agent declares the current work item via the
      `yoke_use_scope` tool (the user states or implies it, e.g. "this is
      ABC-12345 work"), which resolves the key to a workstream and pins it as the
      session's default injection/capture scope. No branch-regex guessing — branch
      names carry the child task key, not the parent workstream everyone shares.

## v5.0 — knowledge viewing (the web tier)

- [x] StoragePort enumeration: bounded, namespace-scoped entity + relation listing
      added to the port, with conformance cases. sqlite, kuzu, qdrant and sharded all
      pass — the suite is the contract, not any one engine's features (invariant 2)
- [x] Entity detail screen — one record: attributes, every version, its relations,
      its authorship edge, computed freshness, citation
- [x] Injection preview screen — exactly what `inject()` would return for a query
      (optionally scope-anchored), cited, and audit-logged per preview: a preview is
      an injection, so it leaves the same trail as one
- [x] Graph explorer — force-directed view of the entity/relation graph, navigable
      from any node, bounded by the enumeration page limit and honest about truncation
- [x] Audit log viewer — the append-only trail, filterable by actor, action and time.
      The screen that makes "who was told what, when" answerable without shell access
- [x] Team access: `yoke serve --auth` browser login over the credentials we already
      mint, a viewer that does NOT carry `verify` (done in v5.0 groundwork), and a
      CSP / body-limit / static-asset baseline
- [x] Frontend rebuild: Next.js `output: 'export'` + React + d3-force → one static
      bundle, still served by the existing node:http server on one port
- [ ] Install UX holds: `npm ci` size and wall time measured before and after, and a
      failed web build still leaves a working CLI
      (code done — install.sh degrades gracefully; the before/after measurement on a
      clean machine is on the human-verification list below)
- [x] Regression closed: a check that *executes* the shipped client bundle, not one
      that greps the HTML for markers (see the v2.5 note)

Human-verification list (the docs/BACKENDS.md pattern) — **not yet done**, and the
boxes above are checked for what automation proves, not for this:

- all nine screens opened in a real browser against a real DB, clicking through a
  verify and watching the row leave the queue
- one `--auth` login with a read-only token, confirming verify is refused with a
  message naming the scope
- one graph-explorer open against a ≥100k-row DB, confirming the truncation banner and
  that `POST /mcp` keeps answering while it is open
- `bash scripts/install.sh` on a clean machine: `npm ci` size and wall time before and
  after, and a forced web-build failure still leaving a working CLI

What automation does prove today: every route and endpoint answers against a real
server, the shipped bundle's scripts parse, all nine screens exist as exported pages,
enumeration passes conformance on four backends, and the injection-quality eval still
reports 0% contamination / 0% missed contradictions.

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified.
When market signals arrive (the first enterprise customer, the second org), the
ordering within v2/v3 can be adjusted.
