# yoke — v1 implementation plan (detailed)

This breaks ROADMAP v0.1–v1.0 down into executable units. SPEC.md is the source of
truth for contracts; this document fixes the order, the files, and the definition
of done. When they conflict, SPEC wins.

## Global rules

- **A task is a commit unit.** Each task is committed with `tsc --noEmit` +
  `biome check` + `vitest run` all green.
- **Dependency-direction check**: core does not import ports/adapters/front.
  (In v0.1 this starts as a directory-structure review rather than a biome/eslint
  rule; add a rule only once a real violation occurs — staying within the "no work
  beyond ROADMAP" principle.)
- The four backward-compatibility constraints (ENTERPRISE.md) apply at all times:
  opaque IDs, a single core path, append-only, and actor-as-person references.

## Unattended-execution protocol (goal mode)

- **Progress tracking**: when a task completes, update its ROADMAP.md checkbox in
  the same commit. On resuming after an interruption, the checkboxes are the resume
  point.
- **Micro-decision rule**: for details SPEC/PLAN are silent on (error message
  wording, sort order, etc.), pick the minimal implementation that doesn't violate
  the non-goals list, and keep going. Don't stall. But **if it looks like you'd
  have to change a SPEC contract (schema, signature, gate order), stop and report**.
- **All external dependencies are non-blocking**: verifications that need a real
  API key or manual confirmation (the Claude Code check in 3.3, real embeddings in
  4.1, real GitHub in 5.2, real-device npx in 7.3) are recorded on the "awaiting
  human confirmation" list and you proceed. The DoD is satisfied by
  stub/fixture-based automated tests.
- **Definition of done**: every automatable DoD in 7.1–7.3 green, plus the
  "awaiting human confirmation" list printed out.

## Final directory layout (as of v1.0)

```
src/
  core/
    types.ts        # Entity, Relation, Provenance, Ontology types
    ontology.ts     # validation + seed + migration
    commit.ts       # gate pipeline (the single write path)
    lifecycle.ts    # status transitions, freshness
    inject.ts       # context injection + citations
    persona.ts      # person-scoped queries + SKILL.md generation
    embedding.ts    # provider client (fetch, OpenAI-compatible)
  ports/
    storage.ts      # StoragePort interface
    conformance.ts  # shared test suite (test factory)
  adapters/
    storage-sqlite/ # index.ts, schema.sql
  connectors/
    github-pr.ts
  front/
    cli/index.ts    # subcommand routing (node:util parseArgs)
    mcp/index.ts    # MCP stdio server
eval/
  inject-quality.ts # contamination-rate measurement
```

---

## v0.1 — core model + SQLite + gate

### 1.1 Project setup

- `npm init` — `"type": "module"`, `"bin": {"yoke": "dist/front/cli/index.js"}`
- deps: `better-sqlite3`, `ulid` / devDeps: `typescript`, `vitest`, `@biomejs/biome`,
  `@types/node`, `@types/better-sqlite3`
- tsconfig: strict, NodeNext, outDir dist / biome.json defaults + import sorting
- scripts: `build` (tsc), `test` (vitest run), `typecheck` (tsc --noEmit),
  `lint` (biome check)
- **DoD**: all four scripts green (against an empty src).

### 1.2 Core types (`core/types.ts`)

Type SPEC's Entity/Relation verbatim. Additional decisions:

- `id`: generated with `ulid()`; consumers treat it only as an opaque string.
- Separate `EntityInput`: the input shape that commit accepts (no id/status/version/
  last_confirmed — those are assigned by the gate). **Forcing, at the type level,
  that adapters and front cannot assemble an Entity directly** is the reason this
  file exists.
- `Provenance.occurred_at`, `last_confirmed`: ISO 8601 string (never store Date
  objects).
- **DoD**: types only. No tests (no logic).

### 1.3 Ontology (`core/ontology.ts`)

```ts
type AttrSpec = { type: 'string'|'number'|'boolean'|'string[]', required?: boolean }
type TypeDef  = { name: string, kind: 'entity'|'relation', attrs: Record<string, AttrSpec> }

validateInput(ontology: TypeDef[], input: EntityInput | RelationInput):
  { ok: true } | { ok: false, reason: string }
seedOntology(): TypeDef[]   // person, fact, decision, term, resource
                            // + authored_by, relates_to, supersedes, conflicts_with
```

- decision attrs: `conclusion` (string, required), `rationale` (string, required),
  `rejected_alternatives` (string[])
- Implement the validator by hand (~40 lines). Do not pull in a schema library like
  ajv or zod — four AttrSpec kinds are enough.
  <!-- ponytail: manual validation of 4 types. Move to zod if a nested-object schema is ever needed -->
- The ontology lives in its own `ontology_types` table (see SPEC — **it bypasses
  the gate**, to avoid a cycle). v0.1 implements only seed store/load; the migration
  command comes in 4.4.
- **Tests**: reject unregistered type / reject missing required / reject type
  mismatch / accept valid / relation's from & to are required.

### 1.4 storage port + conformance (`ports/`)

- `storage.ts`: SPEC's interface verbatim + `init(): Promise<void>`, `close()`
- `conformance.ts`: a **test factory** that adapter tests call:

```ts
export function describeStoragePort(name: string, make: () => Promise<StoragePort>)
```

Cases included (minimal set, expanded in v1.0):
1. putEntity → getEntity round-trip
2. **putEntity with the same id again → both versions exist; getEntity returns the latest, or a past one when a version is specified**
3. no physical-delete API (verified at the interface level)
4. putRelation → neighbors direction filter (in/out/both)
5. neighbors relType filter
6. search: FTS match / empty array on no results
7. getEntity on a missing id → null
8. similar returns undefined on adapters that don't implement it (verifies the absent capability)

- **DoD**: the suite self-validates against an in-memory fake (the fake is a test
  helper only — not placed under src).

### 1.5 storage-sqlite (`adapters/storage-sqlite/`)

schema.sql:

```sql
CREATE TABLE entities (
  id TEXT NOT NULL, version INTEGER NOT NULL,
  type TEXT NOT NULL, status TEXT NOT NULL,
  attributes TEXT NOT NULL,          -- JSON
  provenance TEXT NOT NULL,          -- JSON
  last_confirmed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
) WITHOUT ROWID;
CREATE TABLE relations ( ... same skeleton + from_id, to_id ... );
CREATE VIRTUAL TABLE entities_fts USING fts5(id UNINDEXED, text);
-- text = type + serialized attributes. On put, keep only the latest version (delete+insert)
```

- WAL mode; `PRAGMA foreign_keys` unused (append-only makes FKs meaningless).
- getEntity latest = `ORDER BY version DESC LIMIT 1`
- **DoD**: passes conformance (`:memory:` and a temp file, both).

### 1.6 commit gate (`core/commit.ts`)

```ts
class CommitRejected extends Error { reason: 'ontology'|'provenance' }

commit(port: StoragePort, ontology: TypeDef[], input: EntityInput|RelationInput,
       prov: Provenance): Promise<{ entity: Entity, duplicates: Entity[] }>
```

v0.1 implements only pipeline stages 1 and 2: ontology validation → provenance
validation (actor/origin/occurred_at non-empty) → assign id/version/status='draft'/
last_confirmed → put. `duplicates` is always `[]` until v0.4 (the signature is
fixed now to avoid a later caller change).

- **Recommitting an existing id = a new version** (the edit path also passes the
  gate, with the same validation).
- **Tests**: two rejection kinds / draft assignment / version bump on recommit /
  relation commit.

### 1.7 CLI skeleton (`front/cli/index.ts`)

- `node:util` parseArgs. Do not pull in commander or similar (we're at ~10
  subcommands).
- `yoke init [--db path]` — defaults to `./yoke.db`. Creates the DB + seeds the
  ontology + **seeds the `yoke:system` person** (the bootstrap actor, see SPEC).
- `yoke add <type> [--actor <id>] [--attr k=v ...]` — goes through commit; prints
  the rejection reason.
  - actor resolution: `--actor` > `YOKE_ACTOR` env > `yoke:system` (a shared helper
    across all commands)
  - repeating `--attr` = string[] (e.g. `--attr alt=a --attr alt=b`)
- `yoke get <id> [--version n]`
- `yoke search <query>`
- DB path resolution: `--db` > `YOKE_DB` env > `./yoke.db` (one shared helper)
- **DoD**: one smoke test (init→add→search run as a child process) + manual scenario
  check. CLI output is human text; `--json` flag for machine output.

---

## v0.2 — lifecycle + injection

### 2.1 lifecycle (`core/lifecycle.ts`)

```ts
verify(port, ids: string[], actor: string): Promise<Entity[]>
  // status→verified, last_confirmed=now. New version row (append-only)
deprecate(port, id, actor)
isFresh(e: Entity, ontology: TypeDef[], now: string): boolean
  // add ttl_days?: number to TypeDef (defaults: fact 180, decision 365, person/term/resource unlimited)
```

- stale is **never stored** — it's decided at read time: `verified && !isFresh` →
  stale. Only deprecated is stored explicitly. (This implements SPEC's read-time
  determination.)
- **Tests**: verify bumps the version / TTL-elapsed determination / unlimited types
  / deprecate.

### 2.2 inject (`core/inject.ts`)

```ts
inject(port, ontology, query: string, opts?: { includeDraft?: boolean, limit?: number })
  : Promise<{ items: Array<{ entity, effectiveStatus, citation: string }> }>
```

- Pipeline: search (+ merge similar from v0.4 on) → compute effectiveStatus →
  verified-only by default → generate citation.
- Citation format is fixed: `[{type}:{id}@v{version}] {actor}, {occurred_at}` — this
  format is the atomic unit of the audit trail. Locked down by a test.
- **Tests**: draft excluded / label shown when includeDraft / stale excluded /
  citation format.

### 2.3 CLI: `review` / `verify`

- `yoke review` — the draft list (id, type, summary, source). Its purpose is to
  **scan the whole thing in one screen and decide in bulk**, so favor a compact
  display over paging.
- `yoke verify <id...>` / `yoke verify --all-drafts` (bulk, for cold start)
- `yoke deprecate <id...>` — exposes lifecycle.deprecate (also used to resolve
  contradictions)
- **DoD**: add (draft) → not in inject → verify → appears. E2E smoke.

---

## v0.3 — MCP server

### 3.1 Server skeleton (`front/mcp/index.ts`)

- add deps: `@modelcontextprotocol/sdk`, `zod` (a peer, for the SDK's tool schemas)
- stdio transport. Started with `yoke mcp [--db path]`.

### 3.2 Three tools

| Tool | Input (zod) | Behavior |
|---|---|---|
| `yoke_inject` | query, includeDraft? | inject() result as citation-included text |
| `yoke_commit` | type, attributes, actor | commit() — a rejection surfaces as a tool error |
| `yoke_record_decision` | conclusion, rationale, rejected_alternatives?, actor | decision-commit shortcut |

- The tool description *is* the agent UX — spell out the trigger condition in the
  description ("if you've reached a decision, call record_decision"). Adoption of
  the MCP server hinges on this.

### 3.3 E2E verification

- **Automated (DoD)**: use the MCP SDK's Client directly in a test — spawn the
  server process over stdio → call record_decision → connect a fresh Client (a
  separate process) → confirm injection via yoke_inject. This automates the check
  for cross-session persistence.
- **Manual (non-blocking, an item on the awaiting-human-confirmation list)**: after
  registering `.mcp.json`, confirm in real use across Claude Code sessions A/B →
  record the result in the README draft.

---

## v0.4 — duplicates + contradictions

### 4.1 Embedding (`core/embedding.ts`)

- Functional implementation of SPEC's `Embedder`: call an OpenAI-compatible
  `/v1/embeddings` directly with fetch (no SDK, ~30 lines). The core functions
  receive the Embedder **as a parameter**.
- Config: `YOKE_EMBED_URL`, `YOKE_EMBED_MODEL`, `YOKE_EMBED_KEY` env. Unset →
  returns `null` → the caller falls back to FTS. A failure also falls back, with a
  stderr warning (an embedding outage must not block commit — this is not a hard
  gate rule).
- **Tests use a deterministic stub Embedder** (e.g. a fixed vector from a word
  hash). No real-API test — confirming a real provider is an item on the
  awaiting-human-confirmation list.

### 4.2 sqlite-vec integration

- add the `sqlite-vec` dep, a `vec0` virtual table (keep only the latest version,
  same policy as FTS).
- implement `similar()` in storage-sqlite → activates the conformance capability
  case.

### 4.3 Gate stages 3 and 4 (`core/commit.ts` extension)

- Stage 3: similar (when available) or FTS for the top 5 → return anything over the
  cosine-similarity/heuristic threshold as `duplicates`. **No auto-merge, no
  auto-reject** — the caller decides (the CLI warns "similar knowledge exists"; the
  MCP tool includes it in the result).
  <!-- ponytail: start with a single threshold constant (0.85). Move to per-type thresholds if precision proves to be a problem -->
- Stage 4: a **decision-type-only heuristic** — when similarity to an existing
  decision is ≥ threshold but the `conclusion` text differs, create a conflicts_with
  edge. The only inputs to the judgment are these two values (there is no "subject"
  concept — the v1 ontology has no such field). General contradiction detection is
  post-v1 (NLI-model territory; not doing it now).
- **Tests**: duplicate candidates returned / empty array below threshold /
  conflicts_with created and both sides preserved.

### 4.4 CLI: `conflicts` / `ontology`

- `yoke conflicts` — the pair list + each source. Resolution is via
  `yoke verify`/`deprecate` (no dedicated command).
- `yoke ontology list` / `yoke ontology add-type <json-file>` (a migration = a new
  version of an ontology record — reusing the same append-only mechanism as
  entities).

---

## v0.5 — capture connectors

### 5.1 Connector contract (`connectors/`)

```ts
type Connector = { name: string, pull(since?: string): AsyncIterable<EntityInput & { externalId: string }> }
```

- A connector is **just an EntityInput producer** — storage must go through the
  commit gate (no side door).
- Idempotency: store `externalId` (e.g. the PR comment URL) in attributes; on rerun,
  skip if the same externalId already exists. That is the entirety of the connectors'
  shared pattern — we don't build a framework.

### 5.2 github-pr connector

- GitHub REST (fetch + `GITHUB_TOKEN`). Do not pull in octokit (two endpoints: the
  pulls list and review comments).
- Mapping: review comment → `decision` draft (conclusion = the comment body verbatim,
  no summarization; rationale = the thread context; actor = the comment author → a
  person entity is auto-created or referenced).
- `yoke connect github-pr --repo owner/name [--since date]`
- **Tests**: fixture JSON → EntityInput mapping / idempotent rerun. (Real API is a
  one-time manual check.)

---

## v0.6 — persona

### 6.1 Person-scoped query (`core/persona.ts`)

```ts
personaQuery(port, ontology, personId, now): Promise<{ decisions: Entity[], facts: Entity[] }>
```

- provenance.actor = personId **or** an authored_by relation → collect that person's
  knowledge, verified+fresh only (reusing inject's filter — no new filter logic).
- The return is just the two groups. The "guiding principles" section of the SKILL.md
  is not a separate entity type; it's **assembled from the rationale of the
  decisions** (no principle type added — the code doesn't invent a concept the
  ontology lacks).

### 6.2 SKILL.md export

- `yoke persona <person-id> [--out dir]` → generates SKILL.md (`now` injected — the
  snapshot test uses a fixed time):
  frontmatter (name: persona-{person}, description) + a guiding-principles section +
  the decision list (conclusion/rationale/citation) + the instruction
  **"never answer without a citation; if it's not in the record, say 'no record'"**.
- The file header carries the generation time + the source knowledge (id@version)
  list — the audit basis for the regenerate-from-scratch principle.
- **Tests**: one snapshot test (fixed fixture → fixed SKILL.md output).

### 6.3 MCP `yoke_persona`

- Input: person, query? — the personaQuery result as citation-included text.

---

## v1.0 — quality + packaging

### 7.1 CI

- GitHub Actions: typecheck + lint + vitest (conformance included), Node 20/22
  matrix.

### 7.2 Injection-quality eval (`eval/inject-quality.ts`)

- Scenario generation: seed N facts, half verified, half draft (the contamination
  assumption) → run the query set → **contamination rate = share of draft entries
  among inject results (target 0%)**, missed-contradiction rate = share of the
  planted opposing-conclusion pairs with no conflicts_with edge.
- A run script (`npm run eval`), not vitest — the numbers are a deliverable (they
  become the marketing-evidence data for MARKET strategy 6).

### 7.3 Packaging

- `npm pack` → install the tarball into a temp directory and auto-confirm a
  `yoke init` cold start (the better-sqlite3/sqlite-vec prebuilt binaries — **the
  single most common distribution trap**). Real-device checks on other platforms are
  an item on the awaiting-human-confirmation list. `npm publish` is out of scope (a
  human decision).
- README: one-line positioning + the 60-second quickstart + the MCP setup.

---

## Ordering-dependency summary

```
1.1 → 1.2 → 1.3 ─┐
        1.4 ─────┼→ 1.6 → 1.7 → [v0.2] 2.1 → 2.2 → 2.3 → [v0.3] 3.x
        1.5 ─────┘                → [v0.4] 4.1 → 4.2 → 4.3 → 4.4
                                  → [v0.5] 5.x → [v0.6] 6.x → [v1.0] 7.x
```

v0.4 and v0.3 can be swapped (both depend only on v0.2). The default is ROADMAP
order.

## Explicit non-goals (rejected even if requested during v1)

Monorepo split, DI container, event bus, plugin system, a config-file format
(env + flags are enough), internationalization, a logging framework (console +
stderr are enough).
