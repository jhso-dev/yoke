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
- [x] Claude Code real-use verification (success criterion: knowledge injection confirmed from another session)

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

- [x] Graph DB adapter (KuzuDB embedded) — passes conformance
- [x] **Neo4j adapter (v5.2)** — the "Neo4j next" half of the line above, and the first backend a
      company can point at its own server. Native full-text index, native vector index and native
      traversal in one engine. It also uncovered why kuzu and qdrant were never reachable from the
      CLI: `YokeStore`'s extension surface is synchronous, so a remote backend has to be composed
      (`storage-composite`) rather than substituted — see docs/BACKENDS.md
- [x] **OpenSearch adapter (v5.4)** — the second remote backend, and the one that shows the
      composite's `RemoteStore` shape was really structural: it needed no change to the port, the
      composite, or `openStore`'s structure. Native BM25 and native k-NN (the plugin ships in every
      distribution), `neighbors` app-level like sqlite. **No dependency** — OpenSearch is REST, so it
      takes a `fetchImpl` the way qdrant does, where neo4j needed 3.8 MB of Bolt driver. Its test suite
      is scoped by index prefix, so unlike the neo4j suite it can run against a cluster that is holding
      a demo
- [x] Vector DB adapter (Qdrant) — a similar-capability implementation, **verified against a real
      server for the first time in v5.4** (21/21). It had only ever passed against its in-memory REST
      fake, which is defensible for a JSON filter surface and is still not the same claim
- [x] **RDB read-mapping**: Postgres/MySQL tables → read-only entity mapping
      (a table-to-ontology mapping declaration file; the enterprise wedge — MARKET strategy 3)
- [x] Audit log (a query API over the immutable record of gate/promotion/injection)
- [x] More connectors: Slack, meeting notes

## v2.5 — web UI

- [x] review/verify dashboard (draft queue, bulk promotion)
- [x] conflicts view (compare and resolve contradiction pairs)
- [x] ontology browser (visualize types and relations)
- [x] persona preview

> Note (2026-07-29): the JSON API behind these four screens shipped and is covered by
> tests, but **the shipped client script never parsed** — an unterminated string literal
> in `src/front/ui/static/index.html.ts` made the whole `<script>` block a SyntaxError, so
> no tab switched and no row loaded in a browser. `ui.test.ts` asserted HTML substrings
> only, so CI stayed green. The boxes stay checked for the API surface they name; the
> browser half is carried into v5.0 as an explicit deliverable rather than quietly
> rewritten here. Lesson recorded in the v5.0 DoD: a substring assertion is never
> evidence that a UI works.

## v3.0 — enterprise (multi-tenancy, auth)

- [x] Server mode (remote access: HTTP + MCP remote)
- [x] auth: OIDC/SSO integration, API tokens
- [x] RBAC: per-ontology-type/namespace permissions (read/write/promote separated —
      the verify permission *is* the knowledge-governance permission)
- [x] Multi-tenancy: namespace isolation (accommodated by the v0.1 ID scheme)
- [x] Per-tenant ontology + shared-ontology inheritance

## v3.5 — distribution + HA

- [x] Replication (read replicas — injection is read-dominated)
- [x] Backup/restore, PITR (built on the append-only history)
- [x] Sharding — tenant-boundary shards + multi-backend federation (--shards, v3.6)

## v4.0 — shared working context

- [x] Entity-scoped injection: `inject(scope: <entity-id>)` — verified knowledge
      within one relation hop of any entity (the generic mechanism; persona is
      the person-shaped instance of the same idea)
- [x] `collaboration` seed entity type + `works_on` relation — a unit of
      collaborative work that groups people and knowledge for its duration
      (orgs can define their own equivalents in their ontology: epic,
      initiative, experiment, …)
- [x] Capture-side linking: `record_decision`/`commit` accept an optional
      scope entity to attach the new knowledge to (relates_to)
- [x] Declaration-based scope: the agent declares the current work item via the
      `yoke_use_scope` tool (the user states or implies it, e.g. "this is
      ABC-12345 work"), which resolves the key to a collaboration and pins it as the
      session's default injection/capture scope. No branch-regex guessing — branch
      names carry the child task key, not the parent collaboration everyone shares.

> Note (2026-07-30): this type shipped as `workstream` and was renamed to `collaboration`.
> Neutral is not the same as recognizable — `workstream` is vendor-free, which is why it was
> chosen, but a first-time reader does not know it, and the definition right above it has always
> read "a unit of **collaborative** work". A type name that is a different word from its own
> definition is a name nobody can guess. `shared context` and `shared memory` were considered and
> rejected: `context` and `memory` are yoke's two most loaded words (context injection; "we sell
> knowledge, competitors sell memory" — MARKET.md), and both imply containment, which this entity
> does not do — knowledge and people point AT it. Nothing else changed: same attributes, same
> `works_on`, same anchor semantics.
>
> A rename that only moves the code is half a rename: every stored row still says the old name, and
> `yoke list --type <new>` answers nothing on a database full of the old one. So `yoke rename-type
> <from> <to>` ships with it — the declaration, every entity and relation version, and the FTS text
> (which embeds the type name) in one transaction. It rewrites existing rows rather than appending,
> which is the only shape that answers the question: appending would leave the old name in every
> historical row. Nothing about the knowledge changes, so no version is invented and no promotion is
> implied. It is the one mutation the append-only history cannot record — it rewrites those very rows
> — so it writes the `rename_type` audit row that is its only trace. An org that prefers a different
> name for this concept runs the same command; the ontology is per-database data.

## v5.0 — knowledge viewing (the web tier)

- [x] StoragePort enumeration: bounded, namespace-scoped entity + relation listing
      added to the port, with conformance cases. sqlite, kuzu, qdrant and sharded all
      pass — the suite is the contract, not any one engine's features (invariant 2)
- [x] Entity detail screen — one record: attributes, every version, its relations,
      its authorship edge, computed freshness, citation
- [x] Injection preview screen — exactly what `inject()` would return for a query
      (optionally scope-anchored), cited, and audit-logged per preview: a preview is
      an injection, so it leaves the same trail as one
- [x] Graph explorer — force-directed view of the entity/relation graph, navigable
      from any node, bounded by the enumeration page limit and honest about truncation
- [x] Audit log viewer — the append-only trail, filterable by actor, action and time.
      The screen that makes "who was told what, when" answerable without shell access
- [x] Team access: `yoke serve --auth` browser login over the credentials we already
      mint, a viewer that does NOT carry `verify` (done in v5.0 groundwork), and a
      CSP / body-limit / static-asset baseline
- [x] Frontend rebuild: Next.js `output: 'export'` + React + d3-force → one static
      bundle, still served by the existing node:http server on one port
- [ ] Install UX holds: `npm ci` size and wall time measured before and after, and a
      failed web build still leaves a working CLI
      (code done — install.sh degrades gracefully; the before/after measurement on a
      clean machine is on the human-verification list below)
- [x] Regression closed: a check that *executes* the shipped client bundle, not one
      that greps the HTML for markers (see the v2.5 note)
- [x] Scale: injection stays correct and bounded at 10M records. Five defects, all measured
      in `docs/SCALE.md` — the cap applied before the freshness filter (50 asked, 29 returned at
      every scale), no relevance order at all (the 50 oldest matches, sharing 1 record in 50 with
      the 50 best), an unbounded `search` on the scope path that heap-crashed at 10M, no secondary
      indexes (a selective type filter took 15 s, `neighbors` was a full scan at 232 ms per call),
      and `search` unbounded when the caller omits a limit
- [x] Text query on browse, and the audit rule made true: `GET /api/search` over the
      port's existing `search()`, plus the `read` row that `GET /api/entity/:id` and
      `yoke get` were supposed to write since v5.0 opened and never did. The ban on a
      human query box is narrowed, not deleted — WEB-UI.md's second 2026-07-31 amendment
      states what replaced it and what stays forbidden

> Note (2026-08-04): the two boxes above were left unchecked after their code merged. The
> convention in this file is that `[ ]` means the work is open — the one exception right above
> them says so in its own text ("code done — … on the human-verification list below"), and these
> two carried no such note, so the file read as if scale and browse-search were unbuilt while
> `docs/SCALE.md` reported the measurements and `/api/search` was answering. Checked after
> verifying the code: `DEFAULT_SEARCH_LIMIT` and the six secondary indexes are in the sqlite
> adapter, and the `read` audit row is written by both `yoke get` and `GET /api/entity/:id`.
> **An unchecked box is a claim about the code, so it needs the same reconciling as a prose
> sentence** — this is the sixth doc-vs-code mismatch found in this repo, and the first where the
> document understated what shipped rather than overstating it.


Human-verification list (the docs/BACKENDS.md pattern) — **one of four done**, and the
boxes above are checked for what automation proves, not for this:

- [x] the screens opened in a real browser against a seeded DB (2026-07-30). It found eleven
      defects that a fully green suite did not, and every one of them was a rendering, a
      volume or a runtime-cost problem — the class of thing an assertion over a JSON payload
      cannot see:
      1. every table's actor column, and every citation, rendered a raw ULID
      2. the audit viewer's detail column — the screen that answers "who was told what" —
         was a list of ids, so it answered in identifiers
      3. `summarize()` existed twice and the web's copy predated the CLI's fix: connector rows
         read as `rdb:table:1` in every web screen
      4. a collaboration briefing had no defined order, so `limit` cut by whichever relation was
         recorded first — and differently per backend
      5. `works_on` put the roster ahead of the knowledge; with `limit: 3` the agent got no
         knowledge at all
      6. no default cap anywhere on MCP or the CLI: a 312-record collaboration briefing was
         ~8,681 tokens because someone pinned a scope
      7. three of the four governance acts left no audit row when done from the CLI — including
         `verify` — while the web tier audited all of them, and the actor filter this list claims
         did not exist. The audit screen could not answer the question it exists for
      8. the graph canvas could pin a core indefinitely: a drag ended by `pointercancel` never
         cleared the drag flag, so the rAF loop ran at 60 fps for the tab's life; every node
         click rebuilt and reheated the whole simulation; hiding the tab reheated it too
      9. the graph drew every edge as an undirected line, so a collaboration read as a hub — and a
         hub reads as a container. A scope anchor contains nothing: knowledge and people point
         AT it. The collaboration screen flattened `in` and `out` together for the same reason, and
         showed less about its own edges than the entity screen did about any record's
     10. every timestamp rendered as stored — `2026-07-30T07:43:58.846Z`. Correct as an audit
         fact and unreadable as an answer to "when": a different hour than the reader's, with
         milliseconds of noise. The same rule as an opaque id, one field over
     11. the audit screen's date filter could not take a date. Its `datetime-local` value was
         written back as `${value}:00Z`, which the control rejects, so it blanked itself on every
         pick — and the same two lines called local wall time UTC, so a working field would have
         queried a window off by the reader's whole offset
      Plus one found only by running the CLI: `yoke inject "" --scope <id>` was rejected by its
      own usage guard, so a briefing was impossible from the terminal.
      The lesson is the v2.5 lesson again, one level up: a green suite proves the payloads, and
      the payloads were right every time. Nothing in it looked at what a person sees.
- [ ] one `--auth` login with a read-only token, confirming verify is refused with a
      message naming the scope
- [x] one graph-explorer open against a ≥100k-row DB, confirming the truncation banner and
      that `POST /mcp` keeps answering while it is open — **done 2026-08-04** against 1,000,000
      entities / 3,005,000 relations in one sqlite file, through `yoke serve` (the process that serves
      both halves, so a graph read that blocked the loop would take MCP with it). `?limit=2000` →
      334 nodes, `truncated: true`; `?limit=3000` → **HTTP 400** naming the maximum, so over-max is an
      error and not a silent cap; `POST /mcp` `yoke_inject` **12/12 answered, worst 33 ms**, during 8
      concurrent max-limit graph reads; `/api/entities` in 1 ms afterwards.
      Two findings the open produced, neither a regression, both worth knowing:
      **(a)** `limit` is divided across entity types, so a corpus concentrated in one type shows
      `ceil(limit/types)` nodes — 334 of the 2,000 asked for. Honest (the banner fires) and stingy.
      **(b)** an un-anchored view of a large corpus draws almost no edges (14 among 334 nodes), because
      only edges with *both* ends in the sampled node set are kept and 334 nodes drawn from a million by
      id order are rarely connected. Correct per its contract, useless to look at. The anchored view is
      the one that works at scale, and it is now the cheap one
- [ ] `bash scripts/install.sh` on a clean machine: `npm ci` size and wall time before and
      after, and a forced web-build failure still leaving a working CLI

What automation does prove today: every route and endpoint answers against a real
server, the shipped bundle's scripts parse, all ten screens exist as exported pages,
enumeration passes conformance on four backends, and the injection-quality eval still
reports 0% contamination / 0% missed contradictions.

Screens are now ten: `collaboration` was added in the browser pass above, because v4.0's shared
working context had no web surface at all — first-class in core, MCP and the CLI, and a
placeholder string in the inject box on the web.

## v5.3 — retrieval gets its second half, and long knowledge becomes readable

- [x] **Hybrid retrieval in `inject`** — the Embedder contract had promised since v0.4 that `null`
      means "retrieval falls back to FTS", and there was no vector path to fall back *from*: every
      injection was keyword-only however the embedder was configured. `search()` and
      `similar(embedder(query), k)` are now fused by Reciprocal Rank Fusion — rank-based, because
      BM25 and cosine are not commensurable. Measured through `inject()` on twelve Korean records
      with four lexical decoys and eight questions worded differently from their answer: keyword-only
      **0/8** accuracy@1, hybrid **7/8** (docs/RESEARCH.md, 2026-08-04). The keyword half returned
      nothing because `search` is AND-of-prefix-tokens and a question is a sentence — not because of
      Korean; an English sentence fails identically
- [x] **A stored document reads as one** — the entity screen rendered every attribute as raw text in
      a table cell, where HTML collapses newlines: a 2,809-character postmortem with 40 line breaks
      and 6 sections came out as one paragraph, and `rejected_alternatives` as `["안 1","안 2"]`. A
      hand-rolled markdown subset (the constructs counted in a real corpus, nothing else) rendered to
      elements rather than `dangerouslySetInnerHTML`, since the input is stored knowledge and no
      writer of it is trusted to emit HTML
- [x] **A person whose id has a colon is still a person** — actor→name resolution skipped any id
      containing one, reading it as a machine identifier, while this repo's own corpus generator mints
      `person:platform-manager`. Every author in every seeded database rendered as a slug on the
      screens whose purpose is keeping ids away from readers

Open, and in this order — the first is the gate on the third by docs/RESEARCH.md's own argument:

- [ ] **Read a real `yoke audit --shape` trail.** The command shipped in v5.2 and nothing has consumed
      it, so the workload ratio that decides whether graph expansion pays is instrumented and still
      unknown. Having the command is not having the answer
- [x] **A gold set, and retrieval metrics over it** (recall@k, nDCG) — done in v5.5 below. The answer
      to "how often does RRF degenerate": on every question-shaped query in the set
- [ ] **Multi-hop traversal** (`inject` walks exactly one relation hop) and **global aggregation** —
      both gated on the trail above, not on appetite
- [ ] **Identity resolution across connector sources** — the same person arriving from Slack, GitHub
      and an RDB mapping is three `person` records today

## v5.5 — the read paths stop paying per row

- [x] **Batch point reads (`getEntities`)** — every read path in core was a loop of `getEntity`, which
      costs nothing on sqlite and is a network round trip per iteration on a remote backend. Measured
      against the live OpenSearch demo with one script on both sides of the change, identical results
      throughout: a briefing **56 → 2** round trips, query injection **63 → 4**, `similar(k=60)`
      **61 → 2**, bulk `verify` of 54 ids **217 → 164** (its read half 54 → 1; the rest are the
      append-only writes). Optional capability with a core-side fallback, so kuzu correctly declines
      it. `similar` was the largest of these and the newest: v5.3 put it on every query injection with
      `k = limit × 3`, and each hit was a point read. Neo4j was already batched there — one backend
      had solved it and the contract had not noticed
- [x] **`verify`/`deprecate` refuse before they write** — the read loop threw on the first unknown id,
      after promoting every id ahead of it. A half-applied governance action, found by moving the read
      out of the loop rather than by a report

- [x] **A gold set, and retrieval metrics over it** — 66 queries over the 504-record demo corpus, each
      naming the records that answer it, scored through `inject()` (`npm run eval:retrieval`). It
      immediately paid for itself by turning v5.3's stated ceiling into a measurement: on **all 55**
      question-shaped queries the keyword half returns **zero** rows, so RRF degeneracy is not an edge
      case in this workload but the operating condition, and the embedder is load-bearing rather than
      optional — with none configured, an agent's question returns nothing. The keyword half is not the
      problem: given a keyword-shaped query it recalls **90.9%**. `search` is AND-of-prefix-tokens, so a
      sentence is an unsatisfiable conjunction (docs/RESEARCH.md). Same numbers on sqlite and
      OpenSearch, which is the first measurement that could have exposed a backend leaking into core
- [x] **The demo corpus lives in the repo** (`scripts/demo-corpus/`, one backend-agnostic loader).
      It had survived being erased from a live Neo4j only because the scratch files were still there

- [x] **The graph routes stopped paying per author** — an anchored open at depth 3 made 1,715 port
      calls, of which **1,595 were actor-name resolution**: one point read per distinct author, twice
      over, because the entity and relation serializers each built their own memo. The traversal
      everyone would have blamed was 117 of them. A memo helps only when authors repeat and in a real
      corpus they do not. Now one batch read per response, shared: **122** calls, byte-identical
      response. Against live OpenSearch, depth 2 went **489 → 65** round trips and depth 3 became
      possible at all — the old shape's request storm failed the server before it answered

Open next, and ahead of the older items below it: **a minimum-should-match rule for `search`.** The
measurement above makes it the highest-value retrieval change available, and it is a change to a
contract clause (conformance case 6c pins AND-of-terms on purpose), so SPEC comes first.

Left standing deliberately: **there is no batch form of `getEntity(id, version)`**, so `listVersions`'s
fallback — and as-of injection through it — is still a loop. Versions are a dense 1..n and a governed
record has two or three, whereas the loops closed above scale with the corpus. Nothing has measured it.

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified.
When market signals arrive (the first enterprise customer, the second org), the
ordering within v2/v3 can be adjusted.
