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

- entity types: `person`, `fact`, `decision` (attributes: conclusion, rationale, rejected_alternatives[]), `term`, `resource`, `collaboration` (attributes: title (required)) — a unit of collaborative work grouping people and knowledge (v4.0). It declares no `status` attribute: every record already carries a lifecycle status, assigned by the gate and moved by verify/deprecate, and a second field of that name in the same form is a confusion, not a feature
- relation types: `authored_by`, `relates_to`, `supersedes`, `conflicts_with` (reserved), `works_on` (person → collaboration, v4.0)
- **Seed applies to new DBs only**: the CLI/MCP load the ontology from the DB, not from the seed. A DB initialized before a seed type was added does not gain it on `yoke init` (init is idempotent and does not re-seed). Migrate an existing DB with `yoke ontology add-type <json-file>` (the documented migration path — no auto-migration).
- **Ontology storage**: stored append-only, with versions, in a separate `ontology_types` table. **It does not pass through the commit gate** — the gate references it, so allowing that would be circular. Changes happen only through an explicit migration via the `yoke ontology` command.
- **Bootstrap**: `yoke init` seeds a person entity with the well-known id `yoke:system` (its provenance.actor is itself). All subsequent actor resolution: `--actor` flag > `YOKE_ACTOR` env > `yoke:system`.

## Storage Port

```ts
interface StoragePort {
  putEntity(e: Entity): Promise<void>        // append-only (new version row)
  getEntity(id: string, version?: number): Promise<Entity | null>
  // optional (v5.5) — the latest version of many ids in one round trip. See "Batch point reads".
  getEntities?(ids: string[]): Promise<Entity[]>
  putRelation(r: Relation): Promise<void>
  neighbors(id: string, relType?: string, dir?: 'in'|'out'): Promise<Relation[]>
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

### Remote backends (v5.2, second one v5.4)

`StoragePort` is fully async and always was, so a network-backed backend implements it with no
interface change. The obstacle is one layer up: the CLI, web and serve tiers hold a **`YokeStore`** —
the port plus sqlite-shaped extensions — and **10 of those 12 extension methods are synchronous**,
because `better-sqlite3` is. A network call cannot satisfy a synchronous signature. That, not a missing
adapter, is why kuzu and qdrant were never reachable from `openStore`: kuzu's own
`saveOntology`/`loadOntology` are `async` and so it does not satisfy `YokeStore`.

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

> ponytail: that cache is read once per `init()`. The CLI opens, inits and closes per command so every
> invocation is fresh, but a long-running `yoke ui`/`serve` will not see an ontology another client
> changed. Add invalidation when that actually bites, not before.

**`RemoteStore` is structural, and v5.4 is the proof.** The composite's remote half is "a `StoragePort`
plus async `saveOntology`/`loadOntology`/`renameType`" — declared as a shape, not a base class, so a
second remote adapter satisfies it without importing the composite. `storage-opensearch` was written
against that shape and needed **no change to the composite, the port, or `openStore`'s structure**; the
only new code outside the adapter directory is one branch selecting it.

Naming both `YOKE_NEO4J_URL` and `YOKE_OPENSEARCH_URL` is an **error**, not a precedence order. They
are two different databases holding two different corpora, and picking one silently would mean
`yoke inject` answering out of a store the caller did not think they were using.

Per-backend rules that are contract rather than implementation are documented in each adapter's header.
For OpenSearch the two worth knowing at this level: reads refresh before they read (it is a
near-real-time engine and the port contract is read-your-writes), and a search's prefix terms are
*required* while its exact terms are what *score* — a Lucene `prefix` query is constant-score, so a
query built only from prefixes satisfies "matches" and silently fails "best match first". The same trap
the Neo4j adapter hit with wildcards.

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
`getEntity` loop, so a backend that omits it is correct and merely slower — an in-process backend
(kuzu) has nothing to gain and does not implement it.

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

   The threshold is boolean rather than a percentage on purpose: AND and OR are the two things all
   five backends express natively, so one rule survives the conformance suite. FTS5 has no
   minimum-should-match, and a `k`-of-`n` rule there is either a combinatorial expansion of every
   `k`-subset or a post-filter over an OR — the second re-creates "asked for 50, received 29" that
   clause 6's filter-before-limit exists to prevent. *ponytail: fixed threshold, promote to a
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

Every implementation must pass the shared `ports/conformance/` test suite.
v1 implementation: `storage-sqlite` (better-sqlite3 + FTS5 + sqlite-vec).
v5.0 implementations that must pass: sqlite, kuzu, qdrant, sharded.

## Commit gate (the single write path)

The `commit(input, provenance)` pipeline — fixed order:

1. Ontology validation (type + attributes schema) → reject on failure
2. Provenance required-field validation → reject on failure
3. Similar-entity lookup **by embedding, or not at all**
   → return duplicate candidates (no auto-merge; propose to the caller)
4. On contradiction, create a `conflicts_with` relation (keep both sides)
4b. Record authorship as an `authored_by` relation (entity → `provenance.actor`), so provenance is
   reachable by graph traversal and not only as a stored field. Idempotent per (entity, actor), no
   self-edge, and skipped when the ontology in force does not declare `authored_by` — a derived edge
   must never fail the caller's own commit. `verify`/`deprecate` do not pass through the gate, so
   promoting is not authoring.
5. Set status='draft', assign a version, and store

**Stage 3 has no FTS fallback, deliberately** (corrected 2026-08-03; this document said "otherwise
FTS" from v1 and the code never did it). When there is no embedder, the embedding request fails, or
the backend has no `similar`, duplicate detection is **skipped entirely** — every FTS candidate would
have to be treated as a duplicate, which yields far too many false positives to put in front of a
person. The code chose this on purpose and only the contract was stale.

Skipping is a fact the caller is told: `commit()` returns
`duplicateDetection: "embedding" | "skipped"`. A front adapter that discards it leaves a person
believing their record was checked for duplicates when it was not — so every adapter that can create
a record must surface `"skipped"`.

The same applies to the vector: a commit with no embedding **still stores the knowledge**. An
embedding provider being down must never reject a record (see "Embedder contract"), so a row can
legitimately exist with no vector, and coverage is repaired by backfill rather than by refusing the
write.

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
  makes a tuned constant defensible at all. *ponytail: one corpus, one language, one model. A floor for
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
| `GET /api/review` | `listEntities({status:'draft', ns})`, or `staleEntities` with `?stale=1` | read | no |
| `GET /api/conflicts` | `listRelationsByType('conflicts_with', ns)` | read | no |
| `GET /api/ontology` | `loadOntology(ns)` | read | no |
| `GET /api/entities` | `listEntities` | read (typed when `?type=`) | no |
| `GET /api/entity/:id` | `getEntity` + `listHistory` + `neighbors` | read (typed) | **yes** (`read`) |
| `GET /api/inject` | `inject(query, {scope, asOf, ns})` | read | **yes** (`inject_preview`) |
| `GET /api/persona/:id` | `personaQuery` | read | **yes** (`persona`) |
| `GET /api/search` | `search({text, type, status, limit, ns})` | read (typed when `?type=`) | **yes** (`search`) |
| `GET /api/graph` | `listEntities` + `listRelations` | read | no |
| `GET /api/audit` | `listAudit({since, ns, limit})` | read | no |
| `POST /api/verify` | `verify` | verify | yes |
| `POST /api/deprecate` | `deprecate` | verify | yes |
| `POST /api/entity` | `commit({type, attributes})` (+ a `relates_to` commit when `scope` is given) | write (typed) | no — the v1 row records it |
| `POST /api/link` | `commit({type, attributes, from, to})` | write (typed) | no — same |
| `POST /api/backfill` | `backfillAuthorship`, or `backfillEmbeddings` with `{embeddings:true, rebuild?}` | write | no — the edges it creates record it, and a vector is not knowledge |
| `POST /api/ontology` | `saveOntology([def], ns)` | **verify** | no |
| `POST /api/rename-type` | `renameType(from, to, ns)` | **verify** | **yes** (`rename_type`) |

Rules that hold for every route:

- **Creation goes through the gate, never around it** (amended 2026-07-31; before that there
  was no HTTP write path into knowledge at all). `POST /api/entity` and `POST /api/link` call
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
  writes is a foot-gun, not a feature), `token` (credential minting stays a terminal act), and
  `mcp` / `ui` / `serve` (process lifecycle, not actions). Plain `search` stays absent for the
  original reason: free-text retrieval for human reading is the search UI this document refuses,
  and the injection preview is the sanctioned query box. Narrowed 2026-07-31: `GET /api/search`
  exposes the port's `search()` to `browse`, returning summary rows and writing a `search` audit
  row. What stays refused is synthesis, a second ranker, and results framed as an answer — see the
  second amendment in WEB-UI.md.
- **Any route that returns knowledge attributes writes an audit row.** A preview is an
  injection: reading through the browser leaves the same trail as reading through MCP
  (ENTERPRISE.md's audit targets include "who got what knowledge injected"). Listing
  routes that return only a truncated summary do not, but a route that returns full
  attributes and cannot be audited must not exist.

  Corrected 2026-07-31: this was false for `GET /api/entity/:id`, which returns full
  attributes and wrote nothing, and for `yoke get`, its CLI twin. Both now write `read`.
  The rule had been in the document since v5.0 opened while the code disagreed with it, so
  it was documentation of an intention rather than of a behaviour.
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
  | `rename_type` | an ontology type was renamed in the declaration and in every stored row | CLI only |

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
yoke deprecate <id...>     # deprecate (e.g. resolving a contradiction)
yoke inject <query> [--include-draft] [--limit n] [--scope id] [--as-of ts]   # retrieve, with citations
yoke conflicts             # list conflicts_with
yoke history <id>          # every version of one id (the append-only rows)
yoke audit [--since ts] [--limit n] [--shape]   # the injection / governance audit trail; --shape counts workload composition
yoke ontology <subcmd>     # inspect types / migrate
yoke persona <person>      # generate/export a persona skill (SKILL.md)
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

**The other backfill** (`--embeddings`, v5.2) repairs the vector index instead of the graph, and it
exists because coverage was a function of which interface wrote the row: `.mcp.json` configures the
embedder for the MCP server's process only, so records created through the CLI or the web tier got no
vector at all. Both backfills are cursor walks with a resumable `after` and a truthful count of what
they examined — the shape `staleEntities` uses, for the same reason: cost is proportional to the corpus
rather than to the answer. `--embeddings` re-embeds every row it reaches rather than skipping ones that
already have a vector, because `getEntity` does not return embeddings and the port therefore cannot be
asked which rows are covered; `putEmbedding` is keyed by `id`, so re-running is idempotent.

### consumption paths

**Primary path — real-time MCP injection**: the `yoke_persona` tool. At call time it runs a person-anchored injection over the verified knowledge and returns text with citations — the same flow as ordinary knowledge injection. Since every call is a regeneration, the derivative principle is satisfied automatically.

**Fallback path — SKILL.md export** (`yoke persona <person> --out`): an offline snapshot for environments with no MCP connection. frontmatter (name/description) + a citation list + a "no answers without a citation" instruction. The file records its generation time and the source knowledge versions so a stale snapshot can be identified.

## Embedder contract

```ts
type Embedder = (text: string) => Promise<Float32Array | null>
```

- The core receives this function type by injection (a fetch-based implementation is provided by core/embedding.ts, while tests inject a deterministic stub).
- The text to embed uses the same serialization function as FTS (type + attributes).
- An embedding failure does not block a commit (warn and proceed — it is not a hard rule).
- **`null` means retrieval falls back to FTS. It does NOT mean duplicate detection falls back to
  anything** (corrected 2026-08-03 — the two were conflated here and in gate stage 3). Retrieval has a
  keyword path to fall back to; duplicate detection does not, and is skipped. Which happened is
  reported as `duplicateDetection`. The vector path this falls back *from* is v5.3 — until then the
  sentence described a fork with one branch (SPEC "Hybrid retrieval").
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
