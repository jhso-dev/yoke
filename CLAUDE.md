# yoke

An ontology-based knowledge database. The core is the knowledge model; everything around it is an adapter.
The goal: AI agents (Claude, Codex, etc.) receive knowledge relevant to the user's context, injected on demand.

## Invariants (never violate)

1. **The core imports no adapter.** Dependencies always point one way: adapter → core.
2. **Every storage backend implements the same storage port interface and passes a shared conformance test suite.** Backend-specific behavior must never leak into the core.
3. **There are exactly two front adapters: the MCP server and a thin CLI.** We do not build a separate adapter per AI tool (one for Claude, one for Codex, and so on) — they are all MCP clients.
4. **v1 is single-user and local-first.** Multi-tenancy, auth, and distribution are out of scope — see the exclusion list in docs/VISION.md and do not add them early.
5. **Knowledge enters only through the core's single commit path, and context injection injects only verified knowledge by default.** For the detailed rules see docs/KNOWLEDGE-POLICY.md — lenient on write, strict on injection.

## Terminology

- **entity**: the smallest unit of knowledge. A node with a type and attributes.
- **relation**: a directed link between entities. It is knowledge in its own right.
- **ontology**: the schema of entity types and relation types. Defined as data, not code.
- **context injection**: selecting the subset of entities/relations relevant to the user's current working context (the query) and handing it to the AI. yoke's core value.
- **storage port**: the backend interface defined by the core. The SQLite, vector DB, and graph DB adapters implement it.
- **decision**: an entity type holding a conclusion, its rationale, and the alternatives that were rejected. The raw material for a persona.
- **persona**: a stored query over verified knowledge sourced from a specific person, exported as a skill. A derivative, not a stored artifact (see docs/VISION.md). Included in v1.

## Layout

- `docs/VISION.md` — why we're building this, and the scope of each version
- `docs/ARCHITECTURE.md` — the port/adapter boundary definitions
- `docs/KNOWLEDGE-POLICY.md` — the knowledge entry gate, lifecycle, and injection filter rules
- `docs/SPEC.md` — the v1 implementation contract (schema, port, gate, MCP tools, CLI)
- `docs/ROADMAP.md` — per-version tasks from v0.1 → v3.5. Build in this order
- `docs/PLAN.md` — the detailed v1 implementation plan (task = one commit, with files, signatures, tests, and DoD)
- `docs/MARKET.md` — the competitive landscape and strategy (surveyed 2026-07)
- `docs/ENTERPRISE.md` — multi-tenancy, auth, RBAC, and distribution design, plus the backward-compatibility constraints that hold from v0.1
- `docs/BACKENDS.md` — backend adapter extension and the RDB read-mapping design
- `docs/WEB-UI.md` — the governance workbench UI design

## Commands

(To be added once code exists: build / test / typecheck / lint)
