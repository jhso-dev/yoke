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

- entity types: `person` (attributes: name (required) — a person is referred to by name on every surface, and the ontology-driven create form offers exactly the declared fields), `fact` (attributes: title, statement (required); `ttl_days: 180` — `statement` is the required one and `title` is not, because the capture connectors turn a message into a statement and have no honest title to give), `decision` (attributes: conclusion, rationale, rejected_alternatives[]; `ttl_days: 365`), `term` (attributes: title (required), statement (required) — a name with no meaning explains nothing and a meaning with no name cannot be looked up), `resource` (attributes: title (required), statement, url), `collaboration` (attributes: title (required)) — a unit of collaborative work grouping people and knowledge (v4.0). Those two `ttl_days` are the seed's only ones; everything else is unlimited, and their absence from this list left the freshness rule below with no stated starting point. `collaboration` declares no `status` attribute: every record already carries a lifecycle status, assigned by the gate and moved by verify/deprecate, and a second field of that name in the same form is a confusion, not a feature. `person` and `collaboration` are marked `structural: true` — they name what knowledge is attached to rather than asserting anything, so injection never returns them as knowledge (see "A roster is not knowledge")
- relation types: `authored_by`, `relates_to`, `supersedes`, `conflicts_with` (created by the gate at stage 4), `works_on` (person → collaboration, v4.0), `same_as` (person → person, v5.6 — see "Identity across sources"), `derived_from` (record → the knowledge it rests on, v5.8 — see "Derivation")
- **Seed applies to new DBs only**: the CLI/MCP load the ontology from the DB, not from the seed. A DB initialized before a seed type was added does not gain it on `yoke init` (init is idempotent and does not re-seed). Migrate an existing DB with `yoke ontology add-type <json-file>` (the documented migration path — no auto-migration).
- **Ontology storage**: stored append-only, with versions, in a separate `ontology_types` table. **It does not pass through the commit gate** — the gate references it, so allowing that would be circular. Changes happen only through an explicit migration via the `yoke ontology` command.
- **Bootstrap**: `yoke init` seeds a person entity with the well-known id `yoke:system` (its provenance.actor is itself). All subsequent actor resolution: `--actor` flag > `YOKE_ACTOR` env > `yoke:system`.

## Storage Port

```ts
interface StoragePort {
  init(): Promise<void>                      // create schema/indexes; must be idempotent
  close(): void
  putEntity(e: Entity): Promise<void>        // append-only (new version row)
  getEntity(id: string, version?: number): Promise<Entity | null>
  // optional (v5.5) — the latest version of many ids in one round trip. See "Batch point reads".
  getEntities?(ids: string[]): Promise<Entity[]>
  putRelation(r: Relation): Promise<void>
  neighbors(id: string, relType?: string, dir?: 'in'|'out'): Promise<Relation[]>
  // q.status may be a single status or an ARRAY (['verified','draft'] is how includeDraft
  // injection asks) — every backend must accept both forms.
  search(q: TextQuery): Promise<Entity[]>    // keyword (FTS)
  // enumeration (v5.0) — the read primitive behind browse and the graph explorer
  listEntities(q: ListQuery): Promise<Page<Entity>>
  listRelations(q: ListQuery): Promise<Page<Relation>>
  // optional capability — if absent, core falls back to keyword search
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>
  // optional (v5.2) — index a vector without writing a version. See "The vector index" below.
  putEmbedding?(e: Entity, opts?: { rebuild?: boolean }): Promise<void>
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

### The vector index (v5.2)

**The embedding is not knowledge — it is a derived index, keyed by `id`, exactly like the FTS row.**
`entities` has no vector column, and only the latest version's vector is kept. Three consequences,
each of them load-bearing:

- **A backfill creates no version and changes no citation.** `putEmbedding` writes the index and
  nothing else, which is what makes repairing coverage possible at all — `putEntity` cannot be reused,
  since re-putting an existing `(id, version)` is a primary-key conflict.
- **A row with no vector is a complete knowledge row.** Coverage is a property of the index, not of the
  knowledge, and it is legitimately incomplete whenever a commit ran without a working embedder.
- **One dimension per database.** The index is created with the first vector's width and every later
  vector must match it. Changing the embedding model therefore requires rebuilding the index, which is
  `putEmbedding(e, { rebuild: true })` on the first row of a backfill.

**A dimension mismatch must fail loudly, on reads and writes alike**, naming both widths and the
command that fixes it. This is the one deliberate exception to "an embedding failure never blocks a
commit": a provider being down costs you one vector, whereas a mixed vector space returns confidently
wrong neighbours forever, and a silent wrong answer is worse than a stopped write.

### Remote backends

`StoragePort` is fully async and always was, so a network-backed backend implements it with no
interface change. The obstacle is one layer up: the CLI, web and serve tiers hold a **`YokeStore`** —
the port plus sqlite-shaped extensions — and **8 of those 12 extension methods are synchronous**
(`backupTo`/`exportUntil` always returned promises; `saveOntology`/`renameType` went async in v5.2),
because `better-sqlite3` is. A network call cannot satisfy a synchronous signature. That, not a missing
adapter, is the bar an adapter clears to be reachable from `openStore` at all: a backend whose
`saveOntology`/`loadOntology` have to be `async` does not satisfy `YokeStore`.

**A remote backend is therefore composed, not substituted.** `storage-composite` delegates the port to
the remote store and the synchronous extensions to a local sqlite. The split is deliberate:

- **Remote:** entities, relations, search, neighbors, the ontology, and embedding vectors. The ontology
  is remote because a shared graph with per-client schemas means two clients validating against
  different schemas.
- **Local:** the audit trail (what THIS client was told) and API tokens (yoke's own credentials, which
  do not belong in someone else's database). Centralising them is the v3.0 `serve --auth` story.

Two methods became async because they touch remote rows — **`renameType`** (it rewrites entity rows)
and **`saveOntology`** (a synchronous fire-and-forget would discard the error). `loadOntology` stays
synchronous, served from a cache the async `init()` fills.

> ceiling: that cache is read once per `init()`. The CLI opens, inits and closes per command so every
> invocation is fresh, but a long-running `yoke ui`/`serve` will not see an ontology another client
> changed. Add invalidation when that actually bites, not before.

**`RemoteStore` is structural.** The composite's remote half is "a `StoragePort` plus async
`saveOntology`/`loadOntology`/`renameType`" — declared as a shape, not a base class, so an adapter
satisfies it without importing the composite. Both remote adapters (`storage-opensearch`,
`storage-postgres`) are written against that shape and need **no change to the composite, the port,
or `openStore`'s structure**: the only code each adds outside its own directory is one branch
selecting it. Naming more than one remote is an error, not a precedence order — they are different
knowledge stores.

Per-backend rules that are contract rather than implementation are documented in each adapter's header.
For OpenSearch the two worth knowing at this level: reads refresh before they read (it is a
near-real-time engine and the port contract is read-your-writes), and a search's prefix terms are
*required* while its exact terms are what *score* — a Lucene `prefix` query is constant-score, so a
query built only from prefixes satisfies "matches" and silently fails "best match first", which is the
same defect a wildcard-only query has.

`listHistory` stays optional and is **absent** on the composite: it is synchronous and it is about
entities, which are remote. Callers use `listVersions(port, id)` (`core/lifecycle.ts`), which
feature-detects the extension and otherwise walks `getEntity(id, version)` — a port method, therefore
async. Its order is **ascending by version**, matching sqlite's `listHistory`; before v5.2 the two
disagreed while the contract said "any order", which is a latent display bug rather than a freedom.

### Batch point reads (v5.5)

Every read path in core was written as a loop of point reads, because on sqlite a point read is a
prepared statement and costs nothing. On a remote backend each iteration is a **network round trip**,
and the loops are not short: one briefing of a collaboration reads every entity one hop from the
anchor, and `similar(embedding, k)` reads one entity per neighbour returned.

`getEntities(ids)` is that loop as one call. It is **optional**, and core falls back to the
`getEntity` loop, so a backend that omits it is correct and merely slower — an embedded backend, where
each iteration is a prepared statement, has nothing to gain, which is why it is optional.

Four clauses, each a conformance case:

1. **Latest version of each id.** Same selection as `getEntity(id)` with no version.
2. **In the order of `ids`**, not storage order. "Any order" is precisely the freedom that let
   `listHistory` and the `listVersions` fallback disagree about version order for two releases, and
   an adapter's own `similar` passes ids in *score* order — a batch read that reshuffled them would
   silently destroy the ranking it was called to make cheaper.
3. **Absent ids are omitted**, not returned as holes. A caller that needs to know which ids were
   missing compares what it asked for against what came back; `verify`/`deprecate` do exactly that
   and refuse the whole batch.
4. **Duplicate ids collapse to one row.** Callers pass sets and arrays interchangeably.

Measured through `inject()` and `verify()` against a live OpenSearch demo (504 records, 1,272
relations, an anchor with 60 relations), by counting the adapter's HTTP calls with the same script on
both sides of the change. **Every row returns the identical result** — same items, same omitted count,
same hit count, same rows written:

| one user action | round trips before | after |
| --- | --- | --- |
| briefing of one collaboration (`limit` 6) | 56 | **2** |
| query injection (`limit` 20, hybrid) | 63 | **4** |
| anchored query injection (`limit` 20) | 63 | **4** |
| `similar(embedding, 60)` on its own | 61 | **2** |
| bulk `verify` of 54 ids | 217 | **164** |

The last row is the shape of what is left: its read half went 54 → 1, and the remaining 163 are
`putEntity` calls. Writes are one call each because the port has no batch write and append-only means
each is a distinct new row — a batch write is a different decision, not a continuation of this one.

The graph routes were measured separately, because their cost turned out not to be where it looked.
Same corpus, same anchor, and the responses are byte-identical before and after (compared by digest):

| `GET /api/graph` | round trips before | after |
| --- | --- | --- |
| `?scope=…&depth=1` (61 nodes, 60 edges) | 183 | **4** |
| `?scope=…&depth=2` (117 nodes, 194 edges) | 489 | **65** |
| `?scope=…&depth=3` (517 nodes, 1,077 edges) | *the request storm failed the server* | **122** |
| `?limit=300` (200 nodes, 300 edges) | *same* | **207** |

**The traversal was not the problem.** Counted per port method against a loaded sqlite corpus, the
depth-3 open made 1,715 calls of which **1,595 were actor-name resolution** — one point read per
distinct author, and twice over, because the entity and relation serializers each built their own memo.
The traversal itself was 117. A memo only helps when authors repeat, and in a real corpus each record
has its own. So actor names now resolve in one batch read per response, shared by both serializers.

What remains is one `neighbors` call per frontier node, issued 16 at a time. `neighbors` takes a single
id and a batch form would be a fifth port method with four implementations behind it; the concurrency
was the free half of that fix.

**There is no batch form of `getEntity(id, version)`,** so the loops that walk *versions* of one id
stay loops: `listVersions`'s fallback, and therefore as-of injection through it. That is a known
remaining N+1 on remote backends, left standing because nothing has measured it — versions are a
dense 1..n sequence and a governed record has two or three of them, whereas the loops closed above
are proportional to the corpus.

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

### search (tightened v5.1)

`search` was specified only as "keyword (FTS)", and three adapters read that as "any N
matching rows". Measured against a ten-million-entity corpus, that is what they returned: the
oldest N, because FTS5 yields rowid order unless asked otherwise and the other two `slice()` a
scan. The top 50 by insertion order and the top 50 by relevance shared **one** record out of
fifty (measured at 1M; `docs/SCALE.md`). Two clauses, both conformance cases:

6. **Relevance order, not storage order.** Results are ordered best-match first. An adapter
   with a native ranker uses it (FTS5's bm25); one without ranks over the rows it already
   materialized. What is forbidden is returning insertion order and calling it a result set,
   because then `limit` silently means "oldest N" and injection hands an agent the wrong
   knowledge without any symptom.
7. **Bounded even when the caller forgets.** `limit` omitted applies
   `DEFAULT_SEARCH_LIMIT`, not "every match". This is a resource bound, not a policy cap:
   at 10M entities an unbounded `search` materialized ten million row objects and the process
   died of heap exhaustion. `listEntities` keeps the opposite default (clause 5) because
   enumeration is a cursor walk the caller drives; search is a top-k the caller consumes.

`status`/`type`/`ns` filters are applied **before** the limit, not after. Injection's freshness
filter is the caller's and still runs after, so front adapters over-fetch — see the gate note in
"context injection".

8. **Long queries are a disjunction (v5.6).** Up to `AND_TERM_LIMIT` (3) tokens every term is
   required, as before. From the fourth token on, a record matches when it contains **any** query
   term, and clause 6's ranking decides what reaches the caller. Both halves are conformance cases.

9. **A query term matches any document token it PREFIXES** — `parseArgs` reaches `parseArgs로`.
   Hangul particles attach to their stem, so tokenizing on non-letter runs leaves them fused, and
   equality matching would make every suffixed occurrence invisible to the exact query. Two
   conformance cases pin it (prefix tolerance, and AND-of-prefixes in any order); this clause was
   enforced by the suite before it was written here, which is the wrong direction for a contract.

10. **There is no delete.** The port exposes no physical-delete API in any spelling — a conformance
   case bans `delete`/`remove`/`purge`/`drop` method names outright. Retirement is `deprecate`, a
   status, and the append-only history stays.

   The rule exists because the AND was answering a question nobody asks. A person searching a wiki
   types two or three terms and means all of them; an agent's user asks a sentence, and a sentence is
   an unsatisfiable conjunction — `결제대행사 승인 요청 타임아웃` matched 1 record where `타임아웃`
   alone matched 3, and the full question matched 0. Measured over `eval/gold-set.json` before this
   clause: **0 of 91 relevant records found on all 55 question-shaped queries**, against 90.9% recall
   on the keyword-shaped ones. The keyword half was not broken; it was answering a different shape.

   What makes the disjunction safe is that ranking arrived first. In v5.1 `search` returned storage
   order, so the AND was the only precision the port had — loosening it then would have handed an
   agent the oldest N records containing any one word. With clause 6 in force, the strictness moved
   into the ranker, and requiring every term became redundant on top of it.

   The threshold is boolean rather than a percentage on purpose: AND and OR are the two things every
   backend expresses natively, so one rule survives the conformance suite. FTS5 has no
   minimum-should-match, and a `k`-of-`n` rule there is either a combinatorial expansion of every
   `k`-subset or a post-filter over an OR — the second re-creates "asked for 50, received 29" that
   clause 6's filter-before-limit exists to prevent. *ceiling: fixed threshold, promote to a
   percentage rule if a measured corpus shows the top-k polluted by one-term matches.*

   **`terms: "all"` opts back into the conjunction at any length**, for callers performing a lookup
   rather than asking a question. The connector idempotency probe is the one in the tree: it searches
   for a single known `external_id` and then filters for it exactly, so every row past that one is
   cost. Measured at 1M entities, a GitHub comment URL (ten tokens) went from 34 ms and 0 rows under
   the old AND to **292 ms and 1,000 materialized rows** under `"auto"`, per ingested item — and back
   to **3 ms** under `"all"`. Not left to a heuristic in the caller, because probing with "the id's
   most distinctive tokens" drops the discriminator (`file:notes/2026-07-01.md#3` loses the `#3`) and a
   lookup that silently misses re-ingests the record, which is the one thing the probe prevents.

`status`/`type`/`ns` filters, and the default bound, apply identically under either rule.

Every implementation must pass the shared conformance suite (`src/ports/conformance-cases.ts`,
runner-neutral data; `src/ports/conformance.ts` is the vitest wrapper).
v1 implementation: `storage-sqlite` (better-sqlite3 + FTS5 + sqlite-vec).

**The supported set is `sqlite`, `sharded`, `opensearch` and `postgres`, and all four must pass.** A
backend is supported when `openStore` resolves it and it passes this suite against a real server; an
adapter reachable only as a `--shards` member is a federation detail, not a supported backend.

## Identity across sources (v5.6)

Two source systems describing the same colleague produce two `person` records, and nothing in the store
says they are one person. An RDB read-mapping over `employees` beside a second over `contractors` is the
case that occurs; a hand-filed person beside a mapped one is the other. The cost lands on the persona,
which is *knowledge sourced from a specific person* — a duplicate record splits that judgment in half
and the missing half is indistinguishable from knowledge the person never recorded.

- **The link is knowledge, not configuration.** A `same_as` relation, filed through the ordinary gate
  (`yoke link <alias> same_as <canonical>`), so it is versioned, attributable, reviewable and
  reversible exactly like the claims around it. No new command and no config file: an identity claim is
  a claim, and it belongs where the others are.
- **Direction is for the reader; resolution follows both ways and transitively.** `identitySet(id)`
  returns every record that is the same person, breadth-first from the query with each frontier sorted.
  A resolver that honoured the arrow would answer one thing asked about the alias and another asked
  about the canonical record, which is two accounts of one person. Cycles and diamonds are expected
  input; the visited set is what makes them safe.
- **Namespace-filtered before following.** `neighbors` takes no `ns`, so a link filed by one tenant
  would otherwise reach another tenant's person. Same hole, same place, same fix as the vector half of
  hybrid retrieval.
- **`same_as` is marked `membership: true`.** It is the flag's behaviour rather than its name that
  applies: this edge is not knowledge, so a briefing anchored on a person must not hand an agent that
  person's *other record* as a finding.
- **Persona is the consumer.** `personaQuery` anchors on each record in the set and unions the results,
  deduplicated by entity id.
- **No fuzzy matching, ever.** Nothing infers identity from a similar name, a shared email domain or an
  embedding distance. A wrong merge attributes one person's judgment to another under their name, it is
  invisible in the output, and no reader of a persona is positioned to catch it. This is the same rule
  that keeps `github-pr` from minting a person for a GitHub login, and for the same reason.

**What this deliberately does not do**, both stated because the roadmap item implied them:

- **Connector handles are not persons.** A Slack `author` and a GitHub login are stored as attribute
  strings, not `person` records — so the pre-v5.6 situation was not "three records", it was one plus
  two opaque strings. Minting a person per unrecognised handle would fill the store with junk-drawer
  people; deciding when a handle deserves one is a policy this document does not yet have, and
  `same_as` is the mechanism that policy would resolve *through* once it exists.
- **No canonical record is elected.** Nothing rewrites an alias's name to the canonical one on a
  screen, because an alias's own `name` is also a true name for that person. *ceiling: add election
  (no outgoing `same_as`, ties by lowest id) when a surface actually shows one person twice.*

**Migration.** `same_as` is a seed type, and the seed applies to new databases only. An existing
database gains it through the documented path, `yoke ontology add-type`, like every other seed change.

## Commit gate (the single write path)

The `commit(input, provenance)` pipeline — fixed order (the order the code executes, which is
what "fixed" has to mean; both derived-edge stages run AFTER the store because the edges need the
new entity's id — a rejection still happens before anything is written, since stages 1–3 come first):

1. Ontology validation (type + attributes schema) → reject on failure
2. Provenance required-field validation → reject on failure
3. Similar-entity lookup **by embedding, or not at all**
   → return duplicate candidates (no auto-merge; propose to the caller)
4. Set status='draft', assign a version, and store
5. On contradiction, create a `conflicts_with` relation (keep both sides)
5b. Record authorship as an `authored_by` relation (entity → `provenance.actor`), so provenance is
   reachable by graph traversal and not only as a stored field. Idempotent per (entity, actor), no
   self-edge, and skipped when the ontology in force does not declare `authored_by` — a derived edge
   must never fail the caller's own commit. `verify`/`deprecate` do not pass through the gate, so
   promoting is not authoring.

**Stage 3 has no FTS fallback, deliberately.** When there is no embedder, the embedding request
fails, or the backend has no `similar`, duplicate detection is **skipped entirely** — every FTS
candidate would have to be treated as a duplicate, which yields far too many false positives to put in
front of a person.

Skipping is a fact the caller is told: `commit()` returns
`duplicateDetection: "embedding" | "skipped"`. A front adapter that discards it leaves a person
believing their record was checked for duplicates when it was not — so every adapter that can create
a record must surface `"skipped"`.

The same applies to the vector: a commit with no embedding **still stores the knowledge**. An
embedding provider being down must never reject a record (see "Embedder contract"), so a row can
legitimately exist with no vector, and coverage is repaired by backfill rather than by refusing the
write.

### Derivation (v5.8 — what rests on this)

`derived_from`: an edge from a record to the knowledge its author says it rests on.

Why it exists: **deprecating a record is not a fix unless what rests on it can be found.** This is the
stale queue's rule one surface over — flagging decay does not repair it, routing it to the thing that
has to change does. The audit trail already records both halves (`inject` logs the ids it returned,
`persona` logs the ids it exported) and cannot answer the question: the two events share no join key,
and the trail is per-client local sqlite rather than knowledge, so it is not traversable by
`neighbors` and does not move with the record between backends. An edge is.

- **Written at the front tier**, as an ordinary gate-passing commit — the same place and mechanism as
  the `relates_to` that `scope` files. The distinction this repo already draws: `conflicts_with` lives
  inside the gate because it is derived from the *content* being committed; a derivation is
  caller-declared, so it belongs where the caller is. **Core `commit` is unchanged.**
- **Caller-asserted, exactly like `provenance.actor`** — lenient on write. The edge claims "the author
  declared this basis", never "the system observed it". It is not inferred from the audit trail: an
  agent that injected 50 records and wrote one decision did not derive that decision from 50 records,
  and a guess here files a false basis under a decision where no reader is positioned to catch it —
  the rule that already forbids inferring identity from a similar name.
- **Not `membership`.** The evidence under a decision *is* knowledge. Consequence, deliberate: the
  anchored walk traverses it, since `inject` follows every non-membership type when `scopeRel` is
  unset, so a collaboration briefing reaches the basis of the decisions it returns. Bounded by `depth`
  and `WALK_BUDGET` and verified-filtered like every other candidate. **Measured: depth 1 is
  unchanged** — a derivation edge joins two records and touches no anchor, so it is first followed at
  depth 2, and the default injection returns what it always did.
- **persona cannot reach one**, and the operative reason is that it is a one-hop walk from a *person*:
  derivation edges run record → record, so none of them touches the anchor. `scopeRel: 'authored_by'`
  narrows that hop further. Both hold, which matters because presenting a fact this person did not
  author as their judgment is the impersonation rule under "persona" — and unlike a `membership` flag,
  this one is a property of the graph's shape rather than a marking somebody has to remember to apply.
- No self-edge, and duplicate sources in one call collapse to one edge. **Skipped entirely when the
  ontology in force does not declare the type** — stage 4b's rule, and it is load-bearing here: the
  seed applies to new DBs only, so every DB written before v5.8 lacks `derived_from`, and without the
  guard an agent passing the argument would see its own commit reported as rejected *after* the
  knowledge was stored. The response carries how many edges were filed rather than assuming, because
  0-on-an-unmigrated-DB is otherwise indistinguishable from success.
- **The value is normalized, and an unresolvable source is dropped rather than filed.** This is the one
  place a relation endpoint is checked, and it is checked because of what the caller can see: `inject`
  and `persona` render a record as `[fact:01K…@v2]`, never as a bare id, so an agent asked for "ids that
  inject returned to you" cites what it was shown. Measured on three agents given the tool and a
  realistic task — all three populated the field unprompted, and **two of the three passed
  `fact:01K…@v2` or `fact:01K…`**, which resolve to nothing. A wrong basis is worse than none, and the
  tool description saying so does not prevent it.

  So the front tier strips a `[…]` wrapper, a `type:` prefix and an `@vN` suffix, then keeps only ids
  that resolve. The response reports `derived_from` (edges filed) and, when any were dropped,
  `derived_from_ignored` with the offending strings — the caller is told, rather than left believing a
  basis was recorded. Everything else about referential integrity is unchanged: the gate validates the
  type and the provenance, not that a relation's endpoints exist, and this normalization lives at the
  front tier rather than in the gate for the same reason the edge itself does.
- Read back with `neighbors(id, 'derived_from', 'in')` = what rests on this. **Every retire path reports
  it** — `yoke deprecate` and `POST /api/deprecate`, which the entity, review and conflicts screens all
  render through one component. Parity runs both directions here: WEB-UI.md forbids a screen doing what
  the CLI cannot, and the workbench being the weaker surface for the governance act it exists to host is
  the same defect facing the other way. The moment of retiring is the one moment someone is looking.
  Named, not counted — "3 records rest on this" routes nobody, which is the stale queue's lesson again.
  **Breaking:** `yoke deprecate --json` and `POST /api/deprecate` are now `{ deprecated, downstream }`
  rather than a bare array; `POST /api/verify` is unchanged, since only retiring gained a second
  question. `downstream` is present-and-empty rather than absent, so a client never has to tell "no
  dependents" from "this build does not report them".
  One hop only (`downstreamOf`); a dependent's own dependents surface when *it* is retired in turn.

## Injection (context injection)

`inject(query, opts)`:

- Default filter: `status === 'verified'` and exclude anything not fresh
  (freshness = `last_confirmed` + a per-ontology-type TTL, **computed at read time**)
- With `opts.includeDraft`, include drafts but label their status in the result.
  stale/deprecated are **always excluded** regardless of options (strict on injection —
  we don't inject a decay signal. Viewing stale is the job of review/CLI)
- Returns: a list of entities, each with its provenance (an auditable citation format)

### Hybrid retrieval (v5.3 — the vector half of "falls back to FTS")

The Embedder contract below has said since v0.4 that `null` means **retrieval falls back to FTS**.
That sentence described a fork with one branch: `inject` had no vector path to fall back *from*, so
every injection was keyword-only no matter how the embedder was configured. Closed here.

- **A query is answered from two ranked lists, fused.** `search()` as before, plus
  `similar(embedder(query), k)` when both the embedder returns a vector and the backend implements
  `similar`. A briefing (anchor, no query) has no query text and is unchanged — there is nothing to
  embed.
- **Fusion is rank-based (Reciprocal Rank Fusion, `1/(60 + rank)`), never score-based.** BM25 and
  cosine are not commensurable, and neither is absolute cosine across embedding models
  (docs/RESEARCH.md, measured 2026-08-03) — so a weighted sum of the two scores would be arithmetic
  on incomparable units. RRF only reads positions. `60` is the published constant (Cormack 2009),
  not a tuned one; there is deliberately no re-ranker.
  **When one half returns nothing the fused order IS the other half's** — fusion buys robustness only
  where both halves retrieve, which is measured rather than assumed (docs/RESEARCH.md 2026-08-04).
- **The keyword half carries weight 0.1 against the vector half's 1 (v5.6).** Published RRF has no
  weights, and this document said there was none to configure; that held only while search clause 8's
  disjunction did not exist. Once a long query became a disjunction, the keyword half stopped returning
  nothing and started returning loosely-related records in confident rank order — and at equal weight
  its rank 1 outranked a vector rank 1 the keyword half had never seen. Measured over
  `eval/gold-set.json`, that cost the configured-embedder path **12 points of accuracy@1** while
  clause 8 was gaining 43 on the keyword-only path. The weight applies to RANKS, so the objection above
  is untouched: still no arithmetic on incomparable scores.
  The value was swept, not chosen, and 0.05–0.2 are indistinguishable on accuracy@1 — a plateau is what
  makes a tuned constant defensible at all. *ceiling: one corpus, one language, one model. A floor for
  the weaker half, not an optimum; if two corpora disagree the answer is a per-deployment setting, not
  a better number in `core/inject.ts`.*
- **`null` from the embedder returns the FTS list untouched**, in the same order as before this
  existed. An unconfigured or unreachable provider must be indistinguishable from v5.2 behaviour, and
  that is the guarantee the constant-vs-fused test pins.
- **A dimension mismatch throws rather than degrading to keyword-only.** `similar` already refuses to
  answer out of an index built by a different model (SPEC "The vector index"), and injection lets that
  error travel: the message names `yoke backfill --embeddings --rebuild`, whereas a silent fallback
  would leave the vector half dead for as long as nobody looked. This is the one embedding failure
  that is *not* a warn-and-proceed — the same exception the write path already makes.
- **`ns` is filtered in core, not pushed down.** `similar(embedding, k)` takes no namespace, so a
  vector hit from another tenant is filtered against the caller's `ns` after retrieval. Not an
  optimization detail — without it the vector half is a cross-tenant leak the FTS half does not have.
- **Stated ceiling: `status` cannot be pushed into the vector half.** `similar` has no status filter,
  so deprecated and stale rows occupy the `k` window and are dropped afterwards by `effectiveStatus`
  like every other candidate. `k` is the caller's limit (or the briefing cap when it names none) times
  the same `STALE_HEADROOM` the FTS half uses. When both halves come back short the answer is a short
  page and `omitted` reports it — the existing contract, unchanged.
- Available everywhere `inject` is: `yoke inject`, `yoke_inject`, `GET /api/inject`. All three already
  build the same env-configured embedder for the commit gate and now pass it here too, so a query
  cannot retrieve differently depending on which front adapter asked.

### As-of injection (v5.2 — "what was true then")

`inject(query, { asOf })` answers the question the version history already holds the data for and had
no way to ask: **what would this query have injected at time T.**

- `asOf` **replaces the read clock** for the whole filter. Freshness is evaluated against `asOf`
  (a record inside its TTL then, expired now, was injectable then), and so is the status.
- Each candidate is **rewound to the version that was current at `asOf`** — the highest version whose
  `provenance.occurred_at <= asOf`. This is the clause that matters: a decision deprecated last week
  was verified a month ago, and without the rewind an as-of read would answer with today's status and
  be wrong in exactly the case the question is asked about. A record with no version at or before
  `asOf` did not exist yet and is excluded.
- Rewinding uses the `listHistory` extension when the backend has one and falls back to walking
  `getEntity(id, version)` down from the latest — no new port method, and the same feature-detect
  `backfillAuthorship` already uses. Both are in the port or documented as an extension, so this adds
  no adapter work and no conformance case.
- **Stated ceiling: as-of narrows what today's index found; it does not re-index the past.** Candidate
  selection is still `search()` over the current FTS rows — and, since v5.3, `similar()` over the
  current vectors, which keeps only the latest version's — so a record whose text was rewritten such
  that it no longer matches the query is not a candidate, even if its older text did match. What
  changes on a `decision` is overwhelmingly its *status*, which is what this does answer; re-indexing
  history would mean a second FTS table per version and is not worth that.
- Available on `yoke inject --as-of` and `GET /api/inject?asOf=`. Deliberately **not** on
  `yoke_inject`: it is a governance question a person asks about the record, and every MCP parameter
  is contract surface an agent must be taught. Add it when an agent needs it, not before.

### The stale queue (v5.2 — implementing a clause that was written and never built)

"Viewing stale is the job of review/CLI" has been in the filter rule above since v1, and neither
`yoke review` nor `/review` ever showed a stale record — both listed `status: 'draft'` only. Stale
knowledge therefore left injection **silently**: no agent received it and no person was told it had
aged out. That is worse than a flag, not better, and it is the one failure mode
docs/RESEARCH.md's freshness findings converge on.

- `staleEntities(port, ontology, now, opts)` returns the records whose **stored** status is `verified`
  but whose `effectiveStatus` is `stale`. `stale` is computed from the ontology's TTL at read time and
  is never persisted, so this cannot be a `listEntities({status})` filter — it is a walk plus the
  read-time computation, which is why it is a named function and not a query parameter.
- **It is a bounded walk with a truthful cursor, not a corpus scan.** The walk pages
  `listEntities({status:'verified'})` and stops once it has `limit` stale rows, returning `next` (the
  cursor to *resume the scan* — the last row examined, not the last stale row, or resuming would skip
  everything in between) and `scanned` (how many verified rows it had to look at to find them). A
  screen that says "12 stale among the first 5,000 verified records" is honest; one that says "12
  stale" after silently giving up is not.
- **The owner is `provenance.actor`**, and it is the point of the surface: a stale record's fix is a
  person re-confirming or retiring it, so the queue is read owner-first. Front adapters resolve the
  actor to a display name like every other surface (no bare ULID where a person reads for meaning).
- **The two actions are the existing ones**: `verify` re-confirms (it refreshes `last_confirmed`, so a
  still-true record leaves the queue with no new verb) and `deprecate` retires. No third lifecycle
  transition is introduced — a stale record is not a new state, it is a verified record that needs a
  human to say whether it still holds.
- Exposed as `yoke review --stale` and `GET /api/review?stale=1` — the same command and route as the
  draft queue, because the contract clause names `review` and because both queues take the same two
  actions. `--type` narrows either queue.
- **The page is ordered by consumption, and each row says its count.** The count is the number of
  `inject` and `persona` audit rows naming the record — what AGENTS have been fed, not what humans
  looked at (`inject_preview`/`read`/`search` do not count) — so re-confirmation effort meets the
  records still reaching agents first. This is an aggregation over the audit trail the front tier
  already writes, computed at the front tier (the trail is not a port concern), and it inherits the
  trail's scope: under `serve` it is the team's central count; a client pointed straight at a shared
  remote backend counts only its own reads. Ordering applies WITHIN the returned page — the cursor
  resumes the scan by position, unaffected by rank.

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
  whatever order a backend returns relations in — creation order on SQLite, whatever the query planner
  chose on a remote one — so the same question would answer differently per backend, which is backend behaviour
  leaking into the core (invariant 2). The `id` tiebreak is what makes the four agree and is not
  optional. The query paths keep search-relevance order; this ordering applies only to a briefing.
- **A briefing is capped, and says so in words.** Core applies no default (that would silently cap
  `personaQuery` too); it exports `BRIEFING_LIMIT = 50` and returns `omitted` — how many its limit
  dropped. On the scope path that is exact (the whole hop set is fetched before filtering); on the
  query path it counts within the over-fetched search window, so it means "this is a page", not a
  corpus-wide remainder. The
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
- **Nor is the thing knowledge is attached to.** An entity type the ontology marks `structural: true`
  (seeded: `person`, `collaboration`) is never injected as knowledge, whatever relation reached it.
  `membership` alone was escapable — it skips the roster EDGE, so linking a person to a collaboration
  with `relates_to` instead of `works_on` put them back in the briefing — and on the persona path the
  walk IS `authored_by`, so nothing kept out the collaborations the subject had created: a project
  name was handed over as something that person knows, competing for the same `limit` as their
  judgments. A caller who names a `membership` relation in `scopeRel` is asking for the roster on
  purpose and still gets it. Ontology **data** for the same reason `membership` is: an org whose unit
  is `squad` or `service` marks that type. The two flags are separate because they say different
  things — one is about an edge, the other about a type — so clearing one does not clear the other.
- The **same filters** apply as unscoped injection: verified-only by default (`includeDraft` still
  works), stale/deprecated always excluded, and the namespace filter is enforced on fetched
  entities (`getEntity` is id-based, so the ns check happens in `inject`, not the port).
- `opts.scopeRel` / `opts.scopeDir` narrow the anchor walk (passed straight to `port.neighbors`).
  Default is every relation type, both directions — right for a collaboration, whose point is
  everything attached to the work.

#### Multi-hop (v5.7)

`opts.depth` (default **1**) is how many relation hops the anchor walk takes. Only meaningful with
`scope`. At `depth: 1` every byte of the result is what v4.0 produced — the generalisation must not
move the default.

Why it exists: a `decision` carrying `supersedes` and rejected alternatives is a multi-hop record by
construction, and multi-hop is one of the three question shapes where graph retrieval measurably beats
vector RAG (docs/RESEARCH.md §5). "What replaced the thing that replaced this" is two hops, and one hop
answered it with silence.

- **Distance is a priority signal, not a relevance one**, which is the same thing v4.0 already said
  about anchoring — this only grades what was binary. With a query: candidates are partitioned by
  distance ascending (1, then 2, … then everything the walk never reached), and fusion still owns the
  order *within* each band. Without a query: distance leads the briefing sort, ahead of
  verified-before-draft and freshness. A hop-3 record is context; a hop-1 record is the subject.
- **A record is held at its shortest distance.** Cycles and diamonds are ordinary graph shapes here,
  not corruption, and a record reachable in 1 hop and again in 3 is a 1-hop record.
- **`authored_by` leaving *any* node is skipped, not just the anchor's.** v4.0 dropped the anchor's own
  author as metadata about the anchor. At depth 2 the un-generalised rule hands an agent the author of
  every neighbour, which is the roster problem `membership: true` exists to prevent, arriving through a
  relation type nobody marked. Authorship pointing *at* a node is still the persona hop and stays.
- **`membership` is skipped at every hop**, on the same rule as depth 1: unless the caller named that
  type in `scopeRel`.
- **The walk is bounded, and never silently.** `WALK_BUDGET = 128` nodes have their edges expanded,
  breadth-first, so what a budget cut removes is always the farthest band. Frontiers are expanded in
  `id` order so a truncated walk is reproducible rather than dependent on the order a backend returns
  relations in (invariant 2, the same reason the briefing sort has an `id` tiebreak). `inject` returns
  `walk: { depth, nodes, truncated }` whenever it walked more than one hop — the deepest distance
  actually reached, the size of the hop set, and whether the budget stopped it. Front adapters turn
  those numbers into words, exactly as they do for `omitted`: an agent that reads a budget-truncated
  two-hop walk as the whole neighbourhood answers from part of the graph without knowing it.
- **Deeper walks surface sibling anchors.** A record attached to two collaborations makes the second
  collaboration a hop-2 result, so at depth 3 the demo corpus returns `collaboration` records among the
  knowledge. That is not new — anchoring on a record already returned its collaboration in v4.0 — and
  the type is in the output, so a reader can tell context from subject.
- **Stated ceiling: one `neighbors` call per expanded node, sequential.** At `depth: 1` that is the
  single call it always was. Measured on the demo corpus from one collaboration: depth 1 → 29 records
  injected in **1** call, depth 2 → 37 (57 reached) in **49**, depth 3 → 50 (70 reached) in **58**,
  depth 4 → 131 (207 reached) in **71**. Depth 4 is 26% of the whole corpus, which is the practical
  answer to how deep is useful: past 3, "everything is context" and nothing is. The batch form would be a sixth port method with four implementations
  behind it, and `WALK_BUDGET` already bounds the count — measure a real multi-hop workload before
  buying that.

### Global aggregation (v5.7)

The third question shape graph retrieval measurably wins on (docs/RESEARCH.md §5), after multi-hop and
temporal. **"What does this organisation actually know?" is unanswerable by retrieval at any limit** —
every retrieval path returns a top-k of a query, and the question is about the shape of the whole.

`overview(port, ontology, now, { ns, top })` → type/status counts, a relation census, the most-connected
records, and who the verified knowledge came from. Exposed as `yoke overview` and `yoke_overview`.

- **Structure, never a summary.** GraphRAG answers this shape by LLM-summarising graph communities.
  yoke does not: this document already refuses synthesis and results framed as an answer, and a
  summary of knowledge is a claim nobody verified. What comes back is a map — counts, degrees, ids —
  and the tool description says so, because an agent handed prose would quote it.
- **Counts are by EFFECTIVE status.** `stale` is computed from the ontology's TTL at read time and
  stored nowhere, so this is the only place the difference between "stored verified" and "injectable
  today" appears as a number. Consequence: two overviews of an unchanged corpus at two instants
  legitimately differ.
- **Authorship comes off the `authored_by` edge, never `provenance.actor`.** `verify` replaces
  provenance, so on a verified record that field names whoever *promoted* it — an authors list built
  from it ranks reviewers, calls them authors, and in a corpus with a single reviewer credits
  everything to one person. The gate mirrors the real author into an edge and promoting does not pass
  through the gate, so the edge is the durable claim. It is also what `personaQuery` anchors on, so an
  overview naming persona candidates and a persona built from one of them cannot disagree.
- **Degree excludes `authored_by` and `membership` types.** Every record has exactly one author edge,
  so counting them adds a constant to everything and puts *people* at the top of a list meant to say
  what knowledge clusters — the "a roster is not knowledge" rule, one surface over. The relation
  **census** still counts every type: that answers "what is in the store", and the per-type breakdown
  is where a reader sees the split.
- **`top` cuts the two ranked lists and never the counts.** An aggregate over a window is not an
  aggregate.
- **Stated ceiling: two full enumeration scans plus one batch read, paged at 500.** Not sampled, on
  purpose — a quietly approximate count is worse than a slow one. Measured: **29 ms / 5 pages** on the
  517-record demo corpus, **12.2 s / 8,010 pages / 420 MB RSS** at 1M entities and 3M relations. Memory
  is the id sets, not the records — holding every entity so the hub list could carry full records
  costs **511 MB**, a read whose memory is the size of the corpus. Only `top` of them are ever
  returned, so they are re-read by id at the end. *ceiling: no incremental counters and
  no cache, and the id sets are still O(entities) — at 10M this needs counting in the backend rather
  than in core. Add either when a deployment runs this often enough to notice.*
- A corpus organised around anchor records will report those anchors as its hubs — on the demo corpus
  all ten are `collaboration` records. That is a true description of it, not a defect, and the type
  column is how a reader tells.

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
| ↳ both take `derived_from: string[]` | the citation ids this record rests on (see "Derivation") — optional, caller-asserted, never inferred |
| `yoke_persona` | person-anchored injection ("what would Alex do") |
| `yoke_use_scope` | declare the current work item → pin it as the session's default scope |
| `yoke_overview` | the shape of the whole corpus — structure, never a summary (see "Global aggregation") |

## HTTP API (v5.0 contract)

Served by `yoke ui` (local, ungated, loopback) and `yoke serve` (gated by `--auth`). The
API is **only the HTTP exposure of core/adapter functions** — no UI-only business logic,
so every action stays achievable from the CLI (WEB-UI.md). One port; the remote MCP
endpoint shares it at `POST /mcp`.

| Route | Core/adapter function | Action | Audited |
|---|---|---|---|
| `GET /` and the static bundle | — (no knowledge) | ungated, even under `--auth` | no |
| `GET /api/meta` | — | ungated | no |
| `GET /api/review` | `listEntities({status:'draft', ns})`, or `staleEntities` with `?stale=1` | read | no |
| `GET /api/conflicts` | `listRelations({type: 'conflicts_with', ns})` | read | no |
| `GET /api/ontology` | `loadOntology(ns)` | read | no |
| `GET /api/entities` | `listEntities` | read (typed when `?type=`) | no |
| `GET /api/entity/:id` | `getEntity` + core `listVersions` + `neighbors` | read (typed) | **yes** (`read`) |
| `GET /api/inject` | `inject(query, {scope, asOf, ns})` | read | **yes** (`inject_preview`) |
| `GET /api/persona/:id` | `personaQuery` | read | **yes** (`persona`) |
| `GET /api/search` | `search({text, type, status, limit, ns})` | read (typed when `?type=`) | **yes** (`search`) |
| `GET /api/graph` | per-type `listEntities` + `neighbors` per node; anchored (`?scope=&depth=1..3`): a breadth-first `getEntity`/`neighbors`/`readEntities` walk | read | no |
| `GET /api/audit` | `listAudit({since, ns, limit})` | read | no |
| `POST /api/verify` | `verify` | verify | yes |
| `POST /api/deprecate` | `deprecate` + `downstreamOf` | verify | yes |
| `POST /api/entity` | `commit({type, attributes})` (+ a `relates_to` commit when `scope` is given) | write (typed) | no — the v1 row records it |
| `POST /api/link` | `commit({type, attributes, from, to})` | write (typed) | no — same |
| `POST /api/backfill` | `backfillAuthorship`, or `backfillEmbeddings` with `{embeddings:true, rebuild?}` | write | no — the edges it creates record it, and a vector is not knowledge |
| `POST /api/ontology` | `saveOntology([def], ns)` | **verify** | no |
| `POST /api/rename-type` | `renameType(from, to, ns)` | **verify** | **yes** (`rename_type`) |
| `GET /api/tokens` | `listTokens` (names + scopes, never secrets) | **verify** | no |
| `POST /api/tokens` | `createToken` — 201 with the plaintext secret, shown once | **verify** | no |
| `DELETE /api/tokens/:name` | `revokeToken` | **verify** | no |

Rules that hold for every route:

- **Creation goes through the gate, never around it.** `POST /api/entity` and `POST /api/link` call
  `commit()` like every other adapter, so a record made in a browser is validated against the
  ontology, enters as `draft`, and needs the same human `verify`. It carries
  `provenance.origin = "web"`, which is what makes hand-typed knowledge visible as such rather
  than merely forbidden. No audit row: the v1 row it produces already carries actor, origin and
  timestamp — the schema's rule for entity mutations. **Editing an existing record's attributes
  over HTTP remains absent**: correcting a record is a new version through the gate, from the
  adapter that owns the source. The lifecycle mutations are still `verify` and `deprecate`, and
  nothing here writes a record in any state but `draft`.
- **The two schema-level writes are gated on `verify`, not `write`.** `POST /api/ontology`
  is the one write that BYPASSES the commit gate — the gate reads the ontology, so validating
  it against itself would be circular — and `POST /api/rename-type` rewrites every stored row
  carrying a name, history included. Neither is a per-type permission, because neither is
  scoped to a type: they change what types mean.
- **Not exposed over HTTP, and why.** `init` (bootstrap: the server is already holding the
  database it would create), `connect <source>` (needs credentials and runs long), `backup` /
  `restore` / `export` (server-side filesystem paths — a browser form choosing where a process
  writes is a foot-gun, not a feature), and `mcp` / `ui` / `serve` (process lifecycle, not actions).

  **`token` IS exposed** (the three routes in the table above). Minting from a browser is gated on
  `verify` — the governance scope — the secret is returned once and never listed, and under plain
  `yoke ui` the routes are as open as the terminal it runs in (invariant 4: same trust boundary).

  `GET /api/search` exposes the port's `search()` to `browse`, returning summary rows and writing a
  `search` audit row. What stays refused is synthesis, a second ranker, and results framed as an
  answer — see the
  query-box guarantees in WEB-UI.md.
- **A 403 names the scope that would have granted the call** (v5.6): `{ error: "forbidden: this
  credential has no 'verify' scope[ for type 'x'[ in namespace 'y']]", required, type?, ns? }`. Only
  the required grant is named, never the credential's own scopes — what the caller holds does not
  change what they must go and ask for, and saying it would mean threading the principal into the
  handler for nothing. The body was `{"error":"forbidden"}` until a read-only token was actually
  pointed at `POST /api/verify` and the refusal turned out to say nothing a person could act on.
- **Any route that returns knowledge attributes writes an audit row.** A preview is an
  injection: reading through the browser leaves the same trail as reading through MCP
  (ENTERPRISE.md's audit targets include "who got what knowledge injected"). Listing
  routes that return only a truncated summary do not, but a route that returns full
  attributes and cannot be audited must not exist.

- **The injection preview is the real `inject()`.** Not a re-implementation with similar
  filters — byte-for-byte what an agent would receive, so the screen cannot drift from
  the behaviour it claims to show. Its audit action is `inject_preview`, distinct from
  `inject`, so a human looking does not pollute the record of what an agent was told.
- **The audit rule is per front ADAPTER, not per route.** The same actions are written
  wherever the act happens, so the trail does not depend on which interface someone used:

  | action | meaning | written by |
  |---|---|---|
  | `inject` | a model received knowledge | MCP, CLI |
  | `inject_preview` | a human saw what a model *would* receive | web only — there is no CLI preview |
  | `persona` | someone's recorded judgment was read | MCP, CLI, web |
  | `read` | a full record — attributes, versions, relations — was read | CLI, web |
  | `search` | someone queried the store for text and got matching records | CLI, web |
  | `verify` | records were promoted | CLI, web |
  | `deprecate` | records were retired | CLI, web |
  | `rename_type` | an ontology type was renamed in the declaration and in every stored row | CLI, web |
  | `overview` | the corpus shape — including hub rows carrying record text — was read | MCP, CLI — the web has no overview route |

  `rename_type` is the exception to "entity mutations need no audit row, the version history records
  them": it rewrites those very rows, so the history cannot record it and this row is the only trace.

  This is written down because the two adapters drifted: the web audited `verify`, `deprecate` and
  `persona` and the CLI audited only `inject`, so "who promoted this" was unanswerable for every
  promotion done through the CLI — the interface ROADMAP v0.2 makes primary for review and verify.
  `detail` uses the same shape in both (`<subject> -> <id> <id> …`, or a bare id list for a
  lifecycle transition) so rows from different adapters are comparable. A parity test in
  `cli.test.ts` asserts the CLI writes the actions it owns and never writes `inject_preview`.

  **The subject is a space-separated token list** (amended v5.2), not one opaque string. A token
  shaped like a ULID names a record and is resolved for reading; anything else is literal text. That
  generalises what the audit route already did for a `persona` row — whose whole subject is a person
  id — and it is what lets an injection say which anchor it used:

  | shape of `detail` | what it records |
  |---|---|
  | `<query> -> <ids>` | an unscoped query |
  | `<anchorId> <query> -> <ids>` | a query with a working-context anchor |
  | `<anchorId> -> <ids>` | a briefing (anchor, no query) |
  | `<anchorId> @<asOf> <query> -> <ids>` | an as-of read — without the timestamp the trail cannot tell a historical read from a current one |

  Three adapters were formatting this string themselves and only the shapes above are legal, so the
  formatter is **one function** in `src/front/display.ts` (where `summarize` already lives for the
  same reason: two copies had drifted and one carried a bug fix the other did not).

  This is what makes the workload composition measurable — which of briefing / plain query / anchored
  query the injections actually are. docs/RESEARCH.md records why that number decides the retrieval
  design and why it must be measured before anything is built on a guess about it. **`yoke audit
  --shape` is the read**: it classifies `inject` rows by the table above and reports as-of separately,
  since a historical read is still one of the three shapes and not a fourth. It counts `inject` only —
  `inject_preview` is a human looking at a screen, and averaging the two would answer what people
  click when the question is what agents ask — and reports the rows it skipped rather than narrowing
  the denominator in silence.
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
yoke add                   # commit one entity through the gate
yoke get <id> [--relations]  # one record; --relations adds its in/out edges
yoke search <text> [--type t] [--status s] [--limit n]   # the port's FTS; what /api/search exposes
yoke link <from> <relation> <to>   # record a relation — the only creation path for one
yoke list [--type t] [--status s] [--limit n] [--after id]   # enumerate (keyset paging)
yoke graph [--limit n]     # the entity/relation graph, bounded, truncation reported
yoke review [--stale] [--type t]   # list drafts; --stale lists verified records past their TTL
yoke verify <id...>        # promote (batch), refresh last_confirmed — also how a stale record is re-confirmed
yoke deprecate <id...>     # deprecate (e.g. resolving a contradiction) — reports what derived_from it
yoke inject <query> [--include-draft] [--limit n] [--scope id] [--depth n] [--as-of ts]   # retrieve, with citations
yoke overview [--limit n]  # the shape of the whole corpus: type/status counts, hubs, authors
yoke conflicts             # list conflicts_with
yoke history <id>          # every version of one id (the append-only rows)
yoke audit [--since ts] [--until ts] [--limit n] [--shape]   # the audit trail; both bounds inclusive; --shape counts workload composition
yoke ontology <subcmd>     # inspect types / migrate
yoke persona <person>      # generate/export a persona skill (SKILL.md)
yoke persona --check <file> # audit an exported SKILL.md against the store now; exit 1 if any source moved
yoke backfill              # derive missing authored_by edges (upgrade path, idempotent)
yoke backfill --embeddings [--rebuild] [--limit n] [--after id]   # repair vector coverage; --rebuild changes dimension
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

**A command reports the store it actually opened, not `--db`.** `--db` names the local sqlite
whatever the backend is, so the human line names the resolved store instead: `shards cfg.json`, or
`http://…:9200 (audit + tokens: ./yoke.db)` on a remote backend, where both halves are true. `--json` keeps
`db` as the local path — a script reading it wants a path — and adds `store` with the label. Same rule
for the "not initialized" refusal.

### Configuration precedence

```
CLI flag  >  environment variable  >  .env in the working directory  >  built-in default
```

`.env` is read by **`node:process.loadEnvFile`** — Node's own parser, no dependency and no format of
ours. Three clauses:

1. **A shell export or a CI secret always wins over the file.** That is Node's precedence, not ours:
   a variable already present in the environment is not overwritten. So `.env` is a default, never an
   override, and no deployment can be silently reconfigured by a file someone left in a directory.
2. **Absent, unreadable, or a directory are all "no `.env`", silently.** The local path must work with
   no configuration at all (invariant 4), so a missing file is the normal case and not a warning.
   Malformed lines are skipped by Node's parser rather than reported — the cost of not owning one.
3. **It is loaded at the CLI entry point only, never by the test suite.** `YOKE_TEST_OPENSEARCH_URL`
   names a cluster whose indices the suite **deletes**; a `.env` that `npm test` honoured would let one
   forgotten line wipe a database. Test variables are passed per-run, and `.env.example` says so.

`.env.example` is committed and lists every `YOKE_*` variable **yoke itself reads** (the installer's
`YOKE_INSTALL_DIR` belongs to `scripts/install.sh`, not to the product). `.env` is gitignored,
because five of those variables are secrets.

Requires Node **>= 20.12** (`process.loadEnvFile`), which is the package's `engines` floor.

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
persona works on every conformant backend (sqlite, sharded, opensearch, postgres).

**Measured, not asserted** (`npm run eval:persona`): against a corpus of five planted failure modes —
another author's records on the same topics, records tied to the person by `relates_to`, the
`derived_from` sources under their decisions, their own drafts, their own aged records — the eval
reports impersonation, draft-leak and stale-leak rates (target 0%) and whole/query recall (target
100%), and exits non-zero on any miss. Both regressions it exists to catch were planted once to prove
it bites: including drafts reads as a 100% draft leak, dropping `scopeRel` as 50% impersonation.

**Upgrade path**: databases written before stage 4b have no authorship edges. `yoke backfill`
re-derives them through the gate from each version's recorded provenance, skipping `origin:
'lifecycle'` rows so the author is credited rather than the promoter. Idempotent.

**The other backfill** (`--embeddings`, v5.2) repairs the vector index instead of the graph, and it
exists because coverage was a function of which interface wrote the row: `.mcp.json` configures the
embedder for the MCP server's process only, so records created through the CLI or the web tier got no
vector at all. `--embeddings` is a cursor walk with a resumable `after` and a truthful count of what
it examined — the shape `staleEntities` uses, for the same reason: cost is proportional to the corpus
rather than to the answer. (`backfillAuthorship` is a single unpaged pass — it predates the cursor
shape and has not needed one, since it runs once per pre-4b database.) `--embeddings` re-embeds every row it reaches rather than skipping ones that
already have a vector, because `getEntity` does not return embeddings and the port therefore cannot be
asked which rows are covered; `putEmbedding` is keyed by `id`, so re-running is idempotent.

### consumption paths

**Primary path — real-time MCP injection**: the `yoke_persona` tool. At call time it runs a person-anchored injection over the verified knowledge and returns text with citations — the same flow as ordinary knowledge injection. Since every call is a regeneration, the derivative principle is satisfied automatically.

**Fallback path — SKILL.md export** (`yoke persona <person> --out`): an offline snapshot for environments with no MCP connection. frontmatter (name/description) + a citation list + a "no answers without a citation" instruction. The file records its generation time and the source knowledge versions so a stale snapshot can be identified.

**Identifying one.** `yoke persona --check <SKILL.md>` re-reads the `Source knowledge` line and
reports each source against the store as it is *now*:

| verdict | meaning |
|---|---|
| `ok` | same version, still injectable |
| `outdated` | the record has a newer version — the snapshot quotes superseded wording |
| `stale` | verified but past its TTL: no longer injectable |
| `deprecated` | retired |
| `superseded` | something `supersedes` it |
| `missing` | not in the store on this `--ns` |
| `draft` | any non-verified stored status is reported verbatim; unreachable through `inject`-built snapshots today, emitted for a hand-edited one |

- **Exit code 1 when any source is not `ok` — and when the file or a header token cannot be parsed**
  (an unreadable source is not a source that is fine), so the check is usable as a CI or pre-commit
  gate. The point of a snapshot that names its sources is that something other than a person can
  read them.
- Parsing is the inverse of `renderPersonaSkill` and lives beside it, asserted by a render → parse
  round trip. A format the writer and reader disagree about is the failure mode of every snapshot.
- It reports; it does not regenerate. Regeneration is `yoke persona <person>`, and choosing when to
  re-export a file that is already in someone's prompt is not a decision a checker should take.

## Embedder contract

```ts
type Embedder = (text: string) => Promise<Float32Array | null>
```

- The core receives this function type by injection (a fetch-based implementation is provided by core/embedding.ts, while tests inject a deterministic stub).
- The text to embed uses the same serialization function as FTS (type + attributes).
- An embedding failure does not block a commit (warn and proceed — it is not a hard rule).
- **`null` means retrieval falls back to FTS. It does NOT mean duplicate detection falls back to
  anything.** Retrieval has a keyword path to fall back to; duplicate detection does not, and is
  skipped. Which happened is reported as `duplicateDetection`.
- **An unconfigured provider is a FUNCTION, not `undefined`.** `makeFetchEmbedder` with no
  `YOKE_EMBED_URL`/`YOKE_EMBED_MODEL` returns `async () => null`, so a `if (embedder)` guard passes
  and the null arrives one step later. Anything deciding "do we have embeddings" must test the
  returned vector, never the presence of the function.

## Time injection

Any core function that needs time (commit, verify, isFresh, persona export) takes `now: string` (ISO 8601) as a parameter. Calling `new Date()` inside the core is forbidden — this is the basis of test determinism and reproducibility. Acquiring the date happens only in the front (CLI/MCP) layer.

## Tech stack

TypeScript, Node ≥ 20, better-sqlite3, sqlite-vec, the MCP SDK (@modelcontextprotocol/sdk).
Embedding: **no model ships with yoke, and none will.** One provider configuration — an
OpenAI-compatible `/embeddings` endpoint — which is why a single implementation reaches OpenAI, Azure,
Ollama, vLLM, TEI and LiteLLM. An in-process ONNX runtime was considered and rejected in v5.2:
`onnxruntime-node` is 258MB, ships all three platforms' binaries in one package with no per-platform
split, and its only multilingual model in `fastembed` adds a further 562MB — for a CLI installed with
`npm i -g`. Every practice surveyed (hosted API, or self-hosted TEI/Ollama behind a provider
abstraction) keeps the model out of the application process.

Recommended local model: **`bge-m3`** (`ollama pull bge-m3` — 1.2GB in Ollama's shared cache, 0 bytes
in this package; 100+ languages, 8192-token context, 1024 dimensions, MIT). `nomic-embed-text` is
English-centric, so a corpus with substantial non-English knowledge should not use it.
