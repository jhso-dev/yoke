# yoke — Architecture

Ports and adapters (hexagonal). The core is pure TypeScript, with no I/O.

```
        AI tools (Claude, Codex, Cursor, …)
                    │ MCP protocol
   ┌────────────────┼────────────────┐
   │  front adapters│                │
   │  ┌───────────┐ │ ┌───────────┐  │
   │  │ MCP server│ │ │ thin CLI  │  │
   │  └─────┬─────┘ │ └─────┬─────┘  │
   │        └───────┴───────┘        │
   │                ▼                │
   │      ┌──────────────────┐       │
   │      │       core       │       │
   │      │ ontology · query │       │
   │      │ context injection│       │
   │      └────────┬─────────┘       │
   │               ▼ storage port    │
   │  ┌────────┐ ┌────────┐ ┌─────┐  │
   │  │ sqlite │ │ vector │ │ ... │  │  ← v1 is sqlite only
   │  └────────┘ └────────┘ └─────┘  │
   └─────────────────────────────────┘
```

## Key decisions

1. **Front adapters converge on a single one: MCP.** Claude, Codex, and Cursor are all MCP clients, so we don't build a per-tool adapter. The CLI is a thin wrapper for humans and for scripts.
2. **The core defines the storage port.** Backend adapters implement it. The interface is only entity/relation CRUD plus search primitives. Backend-specific features (vector similarity and the like) are declared as optional capabilities, and the core falls back when they're absent.
3. **The ontology is data.** The entity-type and relation-type schemas are records stored inside yoke, not TypeScript types — because every organization's ontology differs.
4. **The conformance test suite is the contract.** Every storage port implementation must pass the same test suite. Adding a new backend = implement the adapter + pass the suite.
5. **Traditional-DB compatibility starts with read-mapping.** The first step is mapping existing RDB tables onto the ontology and exposing them as read-only entities. Bidirectional sync comes after.

## Directory layout (once code exists)

```
src/
  core/          # knowledge model, ontology, query, context injection. imports: none (pure)
  ports/         # storage port interface + conformance test suite
  adapters/
    storage-sqlite/
  front/
    mcp/         # MCP server
    cli/
```

The boundary is enforced by lint (core must not import from adapters/front). Add the rule once code exists.
