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

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified.
When market signals arrive (the first enterprise customer, the second org), the
ordering within v2/v3 can be adjusted.

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
