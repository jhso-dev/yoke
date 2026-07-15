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

- entity types: `person`, `fact`, `decision` (attributes: conclusion, rationale, rejected_alternatives[]), `term`, `resource`
- relation types: `authored_by`, `relates_to`, `supersedes`, `conflicts_with` (reserved)
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
  // optional capability — if absent, core falls back to keyword search
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>
}
```

Every implementation must pass the shared `ports/conformance/` test suite.
v1 implementation: `storage-sqlite` (better-sqlite3 + FTS5 + sqlite-vec).

## Commit gate (the single write path)

The `commit(input, provenance)` pipeline — fixed order:

1. Ontology validation (type + attributes schema) → reject on failure
2. Provenance required-field validation → reject on failure
3. Similar-entity lookup (embedding if `similar` exists, otherwise FTS)
   → return duplicate candidates (no auto-merge; propose to the caller)
4. On contradiction, create a `conflicts_with` relation (keep both sides)
5. Set status='draft', assign a version, and store

## Injection (context injection)

`inject(query, opts)`:

- Default filter: `status === 'verified'` and exclude anything not fresh
  (freshness = `last_confirmed` + a per-ontology-type TTL, **computed at read time**)
- With `opts.includeDraft`, include drafts but label their status in the result.
  stale/deprecated are **always excluded** regardless of options (strict on injection —
  we don't inject a decay signal. Viewing stale is the job of review/CLI)
- Returns: a list of entities, each with its provenance (an auditable citation format)

## MCP tools

| Tool | Role |
|---|---|
| `yoke_inject` | contextual query → inject verified knowledge (with citations) |
| `yoke_commit` | load knowledge (through the gate) |
| `yoke_record_decision` | a commit shortcut dedicated to decision entities |
| `yoke_persona` | person-scoped injection ("what would Alex do") |

## CLI commands

```
yoke init                  # create the DB + seed the default ontology
yoke add / get / search    # basic CRUD and search
yoke review                # list drafts
yoke verify <id...>        # promote (batch), refresh last_confirmed
yoke deprecate <id...>     # deprecate (e.g. resolving a contradiction)
yoke conflicts             # list conflicts_with
yoke ontology <subcmd>     # inspect types / migrate
yoke persona <person>      # generate/export a persona skill (SKILL.md)
yoke connect github-pr     # PR review comments → load as draft decisions
yoke mcp                   # start the MCP server (stdio)
```

## persona consumption paths

**Primary path — real-time MCP injection**: the `yoke_persona` tool. At call time it runs a person-scoped query over the verified knowledge and returns text with citations — the same flow as ordinary knowledge injection. Since every call is a regeneration, the derivative principle is satisfied automatically.

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
