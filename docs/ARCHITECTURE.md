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
   │  │ sqlite │ │ vector │ │ ... │  │  ← sqlite, opensearch, postgres
   │  └────────┘ └────────┘ └─────┘  │
   └─────────────────────────────────┘
```

## Key decisions

1. **Front adapters converge on a single one: MCP.** Claude, Codex, and Cursor are all MCP clients, so we don't build a per-tool adapter. The CLI is the door for humans and for scripts, and it is a **client**: it reaches the corpus over HTTP, so `serve` and `ui` are the only commands that open a store.
2. **The core defines the ports; there are two.** The storage port holds the knowledge; the audit port (`ports/audit.ts`) holds the trail, separate because it is a different shape of data with a different access pattern — append-only, read as the most recent N, never joined against knowledge — and because it has its own address (`YOKE_AUDIT_URL`), so the trail can live in a different database from the corpus. Backend adapters implement the storage port: entity/relation CRUD, search primitives, and cursored namespace-scoped enumeration. Enumeration belongs in the port rather than in an adapter extension because every backend must answer it and it is a core read surface, not a CLI convenience. Backend-specific features (vector similarity and the like) are declared as optional capabilities, and the core falls back when they're absent. The interface itself is in SPEC "Storage Port", which is where its contracts — including why enumeration's default is the opposite of search's — are stated once.
3. **The ontology is data.** The entity-type and relation-type schemas are records stored inside yoke, not TypeScript types — because every organization's ontology differs.
4. **The conformance test suite is the contract — one per port.** Every storage port implementation passes `ports/conformance.ts`; every audit port implementation passes `ports/audit-conformance.ts`. Adding a new backend = implement the adapter + pass the suite for each port it claims. A backend may decline a port, but it must then refuse at boot and say so rather than degrade: OpenSearch cannot hold the ledger (a document appended per read is what a segment-merging index is worst at), so it demands `YOKE_AUDIT_URL`.
5. **Traditional-DB compatibility starts with read-mapping.** The first step is mapping existing RDB tables onto the ontology and exposing them as read-only entities. Bidirectional sync comes after.
6. **The HTTP tier is a transport, not a third front adapter.** Invariant 3 ("exactly two front adapters") is a rule about *clients*: one protocol for AI tools (MCP) and one for humans at a terminal (the CLI), never one adapter per AI tool. `front/ui` and `front/serve` add no third client protocol and no capability of their own — they expose over HTTP the same core functions the CLI already exposes, for humans in a browser, and `web/` is only the rendering of those responses. Three rules keep that true rather than aspirational: (a) every action the HTTP tier performs must be achievable from the CLI (WEB-UI.md, since v2.5); (b) no business logic lives in `front/ui`/`front/serve` — behaviour that cannot be expressed as a call into core or an adapter method belongs in core; (c) `web/` talks only to the documented JSON API, never to a store. When a screen wants something the CLI cannot do, the answer is a core function and a CLI command, not a route.

## Directory layout

```
src/
  core/          # knowledge model, ontology, query, context injection. imports: none (pure)
  ports/         # storage port + audit port, each with its own shared conformance cases
  adapters/
    storage-sqlite/  storage-opensearch/  storage-postgres/
    storage-sharded/    # composes member ports behind one port
    storage-composite/  # a knowledge backend + an audit ledger, with a synchronous ontology cache
    audit-dynamodb/     # the audit port alone — REST + SigV4 in node:crypto, no SDK
  connectors/    # external source → signed knowledge (github-pr, slack, notes, raw, relate, rdb)
  front/
    mcp/         # the MCP tools; served at POST /mcp, which stdio `yoke mcp` relays to
    cli/         # thin CLI — a client
    remote.ts    # the CLI's only way to the corpus: HTTP to a `yoke serve`, credential and all
    store.ts     # store resolution (--db vs --shards vs a remote), opened by serve and ui alone
    ui/          # HTTP transport: node:http server + JSON API + static serving (yoke ui)
    serve/       # the same handler plus auth/RBAC and remote MCP, on one port
plugin/          # the Claude Code harness, shipped from this repo
web/             # Next.js `output: 'export'` source → one static bundle
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
