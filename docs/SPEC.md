# yoke — Spec (v1 contract)

Defines only the contract the implementation must follow. For background and rationale, see ARCHITECTURE/KNOWLEDGE-POLICY. If a contract change is needed during implementation, change this document first and then the code.

## Entity

```ts
{
  id: string          // ULID. an opaque string that may accept a namespace prefix
  type: string        // an entity type registered in the ontology (commit rejected if unregistered)
  attributes: Record<string, unknown>  // validated against the ontology's per-type schema
  status: 'draft' | 'verified' | 'stale' | 'deprecated'
  provenance: {
    actor: string     // a person entity id or an agent identifier (required)
    origin: string    // 'cli' | 'mcp' | 'connector:github-pr' | ...
    occurred_at: string  // ISO 8601 (required)
  }
  version: number     // starts at 1. an edit appends a new version (no overwrite)
  last_confirmed: string  // ISO 8601. refreshed on verify
  embedding?: Float32Array // for duplicate detection and semantic search (sqlite-vec)
}
```

## Relation

Same skeleton as an entity (id/type/status/provenance/version). Plus:

```ts
{ from: string, to: string }  // entity ids. directed
```

## Default ontology (seed)

- entity types: `person`, `fact`, `decision` (attributes: conclusion, rationale, rejected_alternatives[]), `term`, `resource`, `collaboration` (attributes: title (required), status) — a unit of collaborative work grouping people and knowledge (v4.0)
- relation types: `authored_by`, `relates_to`, `supersedes`, `conflicts_with` (reserved), `works_on` (person → collaboration, v4.0)
- **Seed applies to new DBs only**: the CLI/MCP load the ontology from the DB, not from the seed. A DB initialized before a seed type was added does not gain it on `yoke init` (init is idempotent and does not re-seed). Migrate an existing DB with `yoke ontology add-type <json-file>` (the documented migration path — no auto-migration).
- **Ontology storage**: stored append-only, with versions, in a separate `ontology_types` table. **It does not pass through the commit gate** — the gate references it, so allowing that would be circular. Changes happen only through an explicit migration via the `yoke ontology` command.
- **Bootstrap**: `yoke init` seeds a person entity with the well-known id `yoke:system` (its provenance.actor is itself). All subsequent actor resolution: `--actor` flag > `YOKE_ACTOR` env > `yoke:system`.

## Storage Port

```ts
interface StoragePort {
  putEntity(e: Entity): Promise<void>        // append-only (new version row)
  getEntity(id: string, version?: number): Promise<Entity | null>
  putRelation(r: Relation): Promise<void>
  neighbors(id: string, relType?: string, dir?: 'in'|'out'): Promise<Relation[]>
  search(q: TextQuery): Promise<Entity[]>    // keyword (FTS)
  // enumeration (v5.0) — the read primitive behind browse and the graph explorer
  listEntities(q: ListQuery): Promise<Page<Entity>>
  listRelations(q: ListQuery): Promise<Page<Relation>>
  // optional capability — if absent, core falls back to keyword search
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>
}

interface ListQuery {
  ns?: string | null   // omitted/null = the default shared namespace ONLY, never "all namespaces"
  type?: string        // entity type, or relation type on listRelations
  status?: string      // stored status only ('stale' is computed at read time, never stored)
  after?: string       // exclusive keyset cursor: id > after
  limit?: number
}

interface Page<T> { items: T[]; next: string | null }
```

Enumeration is the only port method that can return the whole database, so its contract
is tighter than the rest. Each clause below is a conformance case:

1. **Namespace-scoped, not optionally.** An implementation must never return a row from
   another namespace. Precedent and non-precedent, both in the same adapter file:
   `listByStatus` takes `ns`, `listRelationsByType` did not — and that omission was a
   live cross-tenant leak in the conflicts view, closed before v5.0 started. Enumeration
   does not repeat it.
2. **Latest version only.** The append-only history is reachable through `listHistory`.
3. **Deterministic total order**, ascending by `id`. Ids are ULIDs, so id order is
   creation order: no sort column, no OFFSET scan, and a cursor that cannot skip or
   duplicate a row.
4. **`next` is truthful.** Non-null only when rows actually remain — adapters over-read
   by one rather than inferring "more" from `items.length === limit`, so a caller can
   report truncation honestly instead of guessing.
5. **Bounded by the caller.** `limit` omitted returns every matching row (the semantics
   `listByStatus` already had, so single-call CLI paths stay single-call); the HTTP tier
   is where a maximum is clamped, and over-max is an error, never a silent cap.

Every implementation must pass the shared `ports/conformance/` test suite.
v1 implementation: `storage-sqlite` (better-sqlite3 + FTS5 + sqlite-vec).
v5.0 implementations that must pass: sqlite, kuzu, qdrant, sharded.

## Commit gate (the single write path)

The `commit(input, provenance)` pipeline — fixed order:

1. Ontology validation (type + attributes schema) → reject on failure
2. Provenance required-field validation → reject on failure
3. Similar-entity lookup (embedding if `similar` exists, otherwise FTS)
   → return duplicate candidates (no auto-merge; propose to the caller)
4. On contradiction, create a `conflicts_with` relation (keep both sides)
4b. Record authorship as an `authored_by` relation (entity → `provenance.actor`), so provenance is
   reachable by graph traversal and not only as a stored field. Idempotent per (entity, actor), no
   self-edge, and skipped when the ontology in force does not declare `authored_by` — a derived edge
   must never fail the caller's own commit. `verify`/`deprecate` do not pass through the gate, so
   promoting is not authoring.
5. Set status='draft', assign a version, and store

## Injection (context injection)

`inject(query, opts)`:

- Default filter: `status === 'verified'` and exclude anything not fresh
  (freshness = `last_confirmed` + a per-ontology-type TTL, **computed at read time**)
- With `opts.includeDraft`, include drafts but label their status in the result.
  stale/deprecated are **always excluded** regardless of options (strict on injection —
  we don't inject a decay signal. Viewing stale is the job of review/CLI)
- Returns: a list of entities, each with its provenance (an auditable citation format)

### Anchored injection (v4.0 — shared working context, and persona)

`inject(query, { scope })` where `scope` is an entity id to anchor on. **One mechanism, two named
entry points**: a `collaboration` anchor is the shared working context, a `person` anchor is a persona.

- **Scope prioritizes, it does not imprison.** A pinned working context must never hide
  org-wide knowledge (or personas — `yoke_persona` is a separate entry point, unaffected by scope).
- With a non-empty `query`: the **full query results** are returned, with knowledge one relation
  hop from the scope entity (both directions via `neighbors(scope)`) **ordered first** — the
  working context leads, org-wide matches still flow in. `limit` applies after ordering.
- With no `query`: only the one-hop set is returned — a briefing of that working context.
  The scope entity itself is never returned.
- **A briefing has a defined order**, and it is part of this contract: verified before draft, then
  most-recently-confirmed first, then `id` ascending as the tiebreak. Without it `limit` cuts by
  whatever order a backend returns relations in — creation order on SQLite, something else on kuzu
  and qdrant — so the same question would answer differently per backend, which is backend behaviour
  leaking into the core (invariant 2). The `id` tiebreak is what makes the four agree and is not
  optional. The query paths keep search-relevance order; this ordering applies only to a briefing.
- **A briefing is capped, and says so in words.** Core applies no default (that would silently cap
  `personaQuery` too); it exports `BRIEFING_LIMIT = 50` and returns `omitted` — how many its limit
  dropped, knowable only on the scope path, which fetches the whole hop set before filtering. The
  three front adapters apply the default to a briefing (anchor + empty query) and never to a query.
  An explicit `limit` always wins.
  A cap is honest **only because the briefing is not the only way in**: the query path searches the
  whole namespace and scope merely re-orders it, so a record past the cap is reached by asking about
  it. That fact must be stated in the output, not implied — for `yoke_inject` the notice is an
  instruction ("the other N are NOT lost: ask a specific question"), because an agent that reads a
  truncated briefing as the complete record answers from part of the knowledge without knowing it.
  A `truncated` boolean would not have carried that.
- **A roster is not knowledge.** Anything reached only through a relation type the ontology marks
  `membership: true` is excluded from a briefing — a collaboration's `works_on` edges name who is
  involved in the work, not what is known about it, and under a `limit` they otherwise crowd the
  knowledge out entirely. Naming that type in `scopeRel` asks for members on purpose and still
  returns them. The flag is ontology **data**, not a relation name in core, because orgs define their
  own equivalents (`assigned_to`, `member_of`); a tenant marks theirs and gets the same behaviour with
  no core change.
- The **same filters** apply as unscoped injection: verified-only by default (`includeDraft` still
  works), stale/deprecated always excluded, and the namespace filter is enforced on fetched
  entities (`getEntity` is id-based, so the ns check happens in `inject`, not the port).
- `opts.scopeRel` / `opts.scopeDir` narrow the anchor walk (passed straight to `port.neighbors`).
  Default is every relation type, both directions — right for a collaboration, whose point is
  everything attached to the work.

**Capture-side linking**: `yoke add --scope <id>`, and the `scope` argument on `yoke_commit` /
`yoke_record_decision`, link new knowledge to a scope entity via a `relates_to` relation created
through a second gate-passing commit at the front tier (core `commit` is untouched).

**Declared scope (MCP server)**: scope is stated, not guessed. The agent declares which work item the
current work belongs to — when the user says so or the agent infers it ("this is `ABC-12345` work") —
by calling `yoke_use_scope { key }`. The key is resolved to an anchor entity: an exact entity id
(`getEntity`), else an entity whose `key` OR `title` attribute equals the key, preferring a
`collaboration` since that is what a work-item key names — any entity type may anchor a session. On a match it is
pinned as the session default for subsequent injections and recordings, and the resolved `{ id, title }`
is returned; on no match the tool returns a non-error hint to create one via `yoke_commit` (type
`collaboration`, attributes `{ title, key }`) and call again. Precedence: a per-call `scope` argument >
the session pin (`yoke_use_scope`) > `YOKE_SCOPE` (an entity id or collaboration key resolved at startup,
for fixed setups). In stateless (serve) deployments the session pin does not persist, so the agent
passes `scope` per call — `yoke_use_scope` still returns the resolved id for reuse.

We deliberately do **not** infer scope from the git branch: branch names usually carry a *child* task
key while the shared context lives on the *parent* collaboration, so regex-from-branch systematically
picks the wrong scope.

## MCP tools

| Tool | Role |
|---|---|
| `yoke_inject` | contextual query → inject verified knowledge (with citations) |
| `yoke_commit` | load knowledge (through the gate) |
| `yoke_record_decision` | a commit shortcut dedicated to decision entities |
| `yoke_persona` | person-anchored injection ("what would Alex do") |
| `yoke_use_scope` | declare the current work item → pin it as the session's default scope |

## HTTP API (v5.0 contract)

Served by `yoke ui` (local, ungated, loopback) and `yoke serve` (gated by `--auth`). The
API is **only the HTTP exposure of core/adapter functions** — no UI-only business logic,
so every action stays achievable from the CLI (WEB-UI.md). One port; the remote MCP
endpoint shares it at `POST /mcp`.

| Route | Core/adapter function | Action | Audited |
|---|---|---|---|
| `GET /` and the static bundle | — (no knowledge) | ungated, even under `--auth` | no |
| `GET /api/meta` | — | ungated | no |
| `GET /api/review` | `listEntities({status:'draft', ns})` | read | no |
| `GET /api/conflicts` | `listRelationsByType('conflicts_with', ns)` | read | no |
| `GET /api/ontology` | `loadOntology(ns)` | read | no |
| `GET /api/entities` | `listEntities` | read (typed when `?type=`) | no |
| `GET /api/entity/:id` | `getEntity` + `listHistory` + `neighbors` | read (typed) | no |
| `GET /api/inject` | `inject(query, {scope, ns})` | read | **yes** (`inject_preview`) |
| `GET /api/persona/:id` | `personaQuery` | read | **yes** (`persona`) |
| `GET /api/graph` | `listEntities` + `listRelations` | read | no |
| `GET /api/audit` | `listAudit({since, ns, limit})` | read | no |
| `POST /api/verify` | `verify` | verify | yes |
| `POST /api/deprecate` | `deprecate` | verify | yes |

Rules that hold for every route:

- **Read-only except lifecycle.** The only mutations are `verify` and `deprecate` on
  records that already exist. There is no HTTP write path into knowledge — capture goes
  through the gate via MCP, the CLI, or a connector.
- **Any route that returns knowledge attributes writes an audit row.** A preview is an
  injection: reading through the browser leaves the same trail as reading through MCP
  (ENTERPRISE.md's audit targets include "who got what knowledge injected"). Listing
  routes that return only a truncated summary do not, but a route that returns full
  attributes and cannot be audited must not exist.
- **The injection preview is the real `inject()`.** Not a re-implementation with similar
  filters — byte-for-byte what an agent would receive, so the screen cannot drift from
  the behaviour it claims to show. Its audit action is `inject_preview`, distinct from
  `inject`, so a human looking does not pollute the record of what an agent was told.
- **The audit rule is per front ADAPTER, not per route.** The same five actions are written
  wherever the act happens, so the trail does not depend on which interface someone used:

  | action | meaning | written by |
  |---|---|---|
  | `inject` | a model received knowledge | MCP, CLI |
  | `inject_preview` | a human saw what a model *would* receive | web only — there is no CLI preview |
  | `persona` | someone's recorded judgment was read | MCP, CLI, web |
  | `verify` | records were promoted | CLI, web |
  | `deprecate` | records were retired | CLI, web |
  | `rename_type` | an ontology type was renamed in the declaration and in every stored row | CLI only |

  `rename_type` is the exception to "entity mutations need no audit row, the version history records
  them": it rewrites those very rows, so the history cannot record it and this row is the only trace.

  This is written down because the two adapters drifted: the web audited `verify`, `deprecate` and
  `persona` and the CLI audited only `inject`, so "who promoted this" was unanswerable for every
  promotion done through the CLI — the interface ROADMAP v0.2 makes primary for review and verify.
  `detail` uses the same shape in both (`<subject> -> <id> <id> …`, or a bare id list for a
  lifecycle transition) so rows from different adapters are comparable. A parity test in
  `cli.test.ts` asserts the CLI writes the five actions it owns and never writes `inject_preview`.
- **Every row carries a citation**, source and version, on every screen (since v2.5).
- **Namespace isolation holds on every route**, including the global listings. `getEntity`
  is id-based and deliberately not ns-filtered, so a route that resolves an id re-checks
  the resulting row's ns — the guard `inject` already applies for the same reason.
- **`verify` is a permission separate from `read` and `write`**, including for a browser
  session. A logged-in human is not automatically a verifier (ENTERPRISE.md).
- **The static shell is ungated even under `--auth`.** It contains no knowledge, and a
  static export has no middleware, so the shell must load before a login form can render.
  Everything that returns data is gated.
- **Bounded input.** Request bodies are capped and `content-type` validated; `limit`
  parameters have documented maxima and over-max is a 400.

Credentials are `Authorization: Bearer` — an API token from `yoke token create` or an
OIDC id_token. No cookie session, therefore no CSRF surface.

## CLI commands

```
yoke init                  # create the DB + seed the default ontology
yoke add / get / search    # basic CRUD and search
yoke get <id> [--relations]  # one record; --relations adds its in/out edges
yoke list [--type t] [--status s] [--limit n] [--after id]   # enumerate (keyset paging)
yoke graph [--limit n]     # the entity/relation graph, bounded, truncation reported
yoke review                # list drafts
yoke verify <id...>        # promote (batch), refresh last_confirmed
yoke deprecate <id...>     # deprecate (e.g. resolving a contradiction)
yoke inject <query> [--include-draft] [--limit n] [--scope id]   # retrieve, with citations
yoke conflicts             # list conflicts_with
yoke history <id>          # every version of one id (the append-only rows)
yoke audit [--since ts] [--limit n]   # the injection / governance audit trail
yoke ontology <subcmd>     # inspect types / migrate
yoke persona <person>      # generate/export a persona skill (SKILL.md)
yoke backfill              # derive missing authored_by edges (upgrade path, idempotent)
yoke rename-type <from> <to>   # rename an ontology type in the declaration AND every stored row
yoke connect <github-pr|slack|notes|rdb>   # external sources → draft knowledge
yoke mcp                   # start the MCP server (stdio)
yoke ui [--port] [--host]  # local governance workbench (loopback, ungated, single-user)
yoke serve [--port] [--host] [--auth] [--replica-of <path>]   # UI + JSON API + remote MCP, one port
yoke token <create|list|revoke>            # API tokens for agents/CI (scopes: ns:type:action)
yoke backup <dest> / yoke restore <src>    # online snapshot, WAL-safe
yoke export --until <ts>   # PITR-lite from the append-only history
```

Common options: `--db <path>` (> `YOKE_DB` > `./yoke.db`), `--ns`, `--actor`, `--json`,
`--shards <config.json>`.

## persona

A persona is the person-anchored reading of an anchored injection — not a second query path.
`personaQuery` is a composition over `inject`:

- Anchor: the person entity, walked with `scopeRel: 'authored_by'`, `scopeDir: 'in'`. Since the gate
  mirrors provenance into `authored_by`, that hop is exactly the knowledge the person authored —
  never what merely touches them (the collaboration they work on, whoever filed their person record).
- Read **strictly**, and this is the one place the two entry points differ: a collaboration anchor
  unions in org-wide query matches, while a persona's `query` filters the person's *own* records.
  Presenting knowledge someone did not author as their judgment would be impersonation.
- Output: decisions vs facts (`classifyPersona`), the rendering shape only. Filtering already
  happened in `inject`.

Because authorship is a graph edge rather than a provenance lookup outside the storage contract,
persona works on every conformant backend (sqlite, kuzu, qdrant, sharded).

**Upgrade path**: databases written before stage 4b have no authorship edges. `yoke backfill`
re-derives them through the gate from each version's recorded provenance, skipping `origin:
'lifecycle'` rows so the author is credited rather than the promoter. Idempotent.

### consumption paths

**Primary path — real-time MCP injection**: the `yoke_persona` tool. At call time it runs a person-anchored injection over the verified knowledge and returns text with citations — the same flow as ordinary knowledge injection. Since every call is a regeneration, the derivative principle is satisfied automatically.

**Fallback path — SKILL.md export** (`yoke persona <person> --out`): an offline snapshot for environments with no MCP connection. frontmatter (name/description) + a citation list + a "no answers without a citation" instruction. The file records its generation time and the source knowledge versions so a stale snapshot can be identified.

## Embedder contract

```ts
type Embedder = (text: string) => Promise<Float32Array | null>
```

- The core receives this function type by injection (a fetch-based implementation is provided by core/embedding.ts, while tests inject a deterministic stub). null = unavailable → FTS fallback.
- The text to embed uses the same serialization function as FTS (type + attributes).
- An embedding failure does not block a commit (warn and proceed — it is not a hard rule).

## Time injection

Any core function that needs time (commit, verify, isFresh, persona export) takes `now: string` (ISO 8601) as a parameter. Calling `new Date()` inside the core is forbidden — this is the basis of test determinism and reproducibility. Acquiring the date happens only in the front (CLI/MCP) layer.

## Tech stack

TypeScript, Node ≥ 20, better-sqlite3, sqlite-vec, the MCP SDK (@modelcontextprotocol/sdk).
Embedding: no default local model — v1 has one provider configuration (e.g. an OpenAI/Anthropic-compatible endpoint); if unconfigured, `similar` is disabled and it falls back to FTS.
