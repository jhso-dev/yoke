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
- [ ] Claude Code real-use verification (success criterion: knowledge injection confirmed from another session)

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

- [ ] Graph DB adapter (KuzuDB embedded first, Neo4j next) — passes conformance
- [ ] Vector DB adapter (Qdrant) — a similar-capability implementation
- [ ] **RDB read-mapping**: Postgres/MySQL tables → read-only entity mapping
      (a table-to-ontology mapping declaration file; the enterprise wedge — MARKET strategy 3)
- [ ] Audit log (a query API over the immutable record of gate/promotion/injection)
- [ ] More connectors: Slack, meeting notes

## v2.5 — web UI

- [ ] review/verify dashboard (draft queue, bulk promotion)
- [ ] conflicts view (compare and resolve contradiction pairs)
- [ ] ontology browser (visualize types and relations)
- [ ] persona preview

## v3.0 — enterprise (multi-tenancy, auth)

- [ ] Server mode (remote access: HTTP + MCP remote)
- [ ] auth: OIDC/SSO integration, API tokens
- [ ] RBAC: per-ontology-type/namespace permissions (read/write/promote separated —
      the verify permission *is* the knowledge-governance permission)
- [ ] Multi-tenancy: namespace isolation (accommodated by the v0.1 ID scheme)
- [ ] Per-tenant ontology + shared-ontology inheritance

## v3.5 — distribution + HA

- [ ] Replication (read replicas — injection is read-dominated)
- [ ] Backup/restore, PITR (built on the append-only history)
- [ ] Sharding designed only after measured limits are confirmed (no upfront design)

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified.
When market signals arrive (the first enterprise customer, the second org), the
ordering within v2/v3 can be adjusted.
