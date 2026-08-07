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
2. **The core defines the storage port.** Backend adapters implement it. The interface is entity/relation CRUD, search primitives, and (v5.0) cursored namespace-scoped enumeration (unbounded when the caller
names no limit — deliberately the opposite default from search, whose clause 7 bounds it). Enumeration belongs in the port rather than in an adapter extension because four backends must answer it and it is a core read surface, not a CLI convenience — and because it is the one method that can egress an entire database, so its contract carries a required namespace, a deterministic order and a cursor (SPEC). Backend-specific features (vector similarity and the like) are declared as optional capabilities, and the core falls back when they're absent.
3. **The ontology is data.** The entity-type and relation-type schemas are records stored inside yoke, not TypeScript types — because every organization's ontology differs.
4. **The conformance test suite is the contract.** Every storage port implementation must pass the same test suite. Adding a new backend = implement the adapter + pass the suite.
5. **Traditional-DB compatibility starts with read-mapping.** The first step is mapping existing RDB tables onto the ontology and exposing them as read-only entities. Bidirectional sync comes after.
6. **The HTTP tier is a transport, not a third front adapter.** Invariant 3 ("exactly two front adapters") is a rule about *clients*: one protocol for AI tools (MCP) and one for humans at a terminal (the CLI), never one adapter per AI tool. `front/ui` and `front/serve` add no third client protocol and no capability of their own — they expose over HTTP the same core functions the CLI already exposes, for humans in a browser, and `web/` is only the rendering of those responses. Three rules keep that true rather than aspirational: (a) every action the HTTP tier performs must be achievable from the CLI (WEB-UI.md, since v2.5); (b) no business logic lives in `front/ui`/`front/serve` — behaviour that cannot be expressed as a call into core or an adapter method belongs in core; (c) `web/` talks only to the documented JSON API, never to a store. When a screen wants something the CLI cannot do, the answer is a core function and a CLI command, not a route.

## Directory layout

```
src/
  core/          # knowledge model, ontology, query, context injection. imports: none (pure)
  ports/         # storage port interface + shared conformance cases
  adapters/
    storage-sqlite/  storage-neo4j/  storage-opensearch/
    storage-sharded/    # composes member ports behind one port
    storage-composite/  # a remote port + a local sqlite for the synchronous extensions
  connectors/    # external source → draft knowledge (github-pr, slack, notes, rdb)
  front/
    mcp/         # MCP server (stdio; also mounted at POST /mcp by serve)
    cli/         # thin CLI
    store.ts     # shared store resolution (--db vs --shards)
    ui/          # HTTP transport: node:http server + JSON API + static serving (yoke ui)
    serve/       # the same handler plus auth/RBAC and remote MCP, on one port
web/             # v5.0: Next.js `output: 'export'` source → one static bundle
```

`web/` sits outside `src/` because `next build` rewrites whichever `tsconfig.json` it
finds; at the repo root it would corrupt the CLI's.

The boundary (core must not import from adapters, front or connectors) is **lint-enforced**:
a `noRestrictedImports` override on `src/core/**` in `biome.json`, so a violation fails
`npm run lint` rather than waiting for a reviewer to notice.

`src/core/**/*.test.ts` is exempt, and deliberately: core's tests drive a real
`SqliteStorage(":memory:")` rather than a hand-written fake, because a fake that satisfies
the port is a second implementation of it and the thing being tested is behaviour against a
real one. The invariant is about what ships, not about what proves it.
