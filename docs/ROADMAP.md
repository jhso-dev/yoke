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

- [x] **OpenSearch adapter (v5.4)** — a backend a company can point at a server it already runs.
      Native BM25 and native k-NN (the plugin ships in every distribution), `neighbors` app-level like
      sqlite. **No dependency** — OpenSearch is REST, so the adapter takes a `fetchImpl`, and the
      `RemoteStore` shape it satisfies is structural: no change to the port, the composite, or
      `openStore`'s structure. A remote backend is composed rather than substituted, because
      `YokeStore`'s extension surface is synchronous — the knowledge goes remote, this client's audit
      trail and tokens stay in a local sqlite (`storage-composite`, docs/BACKENDS.md). Its test suite is
      scoped by index prefix, so it can run against a cluster that is holding a demo
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
      added to the port, with conformance cases. sqlite, sharded and opensearch all pass —
      the suite is the contract, not any one engine's features (invariant 2)
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
- [x] Install UX holds: `npm ci` size and wall time measured before and after, and a
      failed web build still leaves a working CLI — **measured 2026-08-05**, on a fresh clone with a
      cold npm cache. It did not hold, and the number was not the web bundle's fault:

      | | wall | on disk |
      | --- | --- | --- |
      | `npm ci` (root, devDeps included) | 31 s | **693 MB** node_modules |
      | `npm run build:cli` | 1 s | 1.9 MB dist |
      | `npm run build:web` | 10 s | +408 MB `web/node_modules` |
      | **`npm ci --omit=dev`** — what `npx yoke` costs a user | 4 s | **581 MB** |

      **531 MB of that 581 MB was one embedded-graph adapter's native binding** — 91% of an end
      user's download, for a backend reachable only through a `--shards` config. Dropping it took a
      consumer install to **44 MB**, and it is the finding that matters more than the number: the web
      toolchain, the thing this box was written to watch, turned out to be the smaller half and only
      lands on a source install
- [x] Graceful degradation verified in the same run: with `build:web` forced to fail, `--help`, `init`
      and `GET /api/review` all work, and with no bundle anywhere `GET /` answers **503** naming
      `npm run build:web`. One nuance worth knowing — a *previously* built `web/out` is still served,
      so the degradation only shows on a machine where the web build has never succeeded
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
- [x] one `--auth` login with a read-only token, confirming verify is refused with a
      message naming the scope (2026-08-05) — and it was not. `yoke serve --auth` on a two-token
      database: the reader gets 200 on `GET /api/entities`, **403 on `POST /api/verify`**, the record
      stays `draft`, the `read,verify` token promotes it to `verified` on the same call, no credential
      gets 401, and the trail attributes the promotion to `token:promoter`. The refusal body, however,
      was `{"error":"forbidden"}` — the holder of a read-only token learned that something was refused
      and not which permission to ask for. Now
      `{"error":"forbidden: this credential has no 'verify' scope", "required":"verify"}`, pinned by a
      test. This is what the item was for: the behaviour was right and the message was not, and no
      amount of green CI was going to say so
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
- [x] `bash scripts/install.sh` on a clean machine: `npm ci` size and wall time before and
      after, and a forced web-build failure still leaving a working CLI — **done 2026-08-05**, the
      numbers and the install-size finding are in the v2.5 "Install UX holds" box above. It was the same
      measurement written down twice, and it did not need a different machine, only a directory
      without this repo's `node_modules`: a fresh clone with its own cold npm cache is that. What
      "clean machine" was protecting against was a warm cache flattering the wall time, which the
      cold-cache column reports honestly

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

- [x] **Read a real `yoke audit --shape` trail** (2026-08-05) — and the answer is that there is no
      workload yet, which is worth more written down than left as "unknown". The only non-synthetic
      trail (`./yoke.db`, the store this repo's own `.mcp.json` points at) holds **5 inject rows, 100%
      plain, 0% anchored, 0% briefing**, all from one dogfooding session on 2026-07-14. The
      instrumentation is not the problem: a demo database shows 3 `inject_preview` and 9 other audited
      actions, so the web tier writes its trail, and `emitShapes` excludes previews on purpose — a
      person clicking a screen does not answer "what do agents ask". n=5 is not a ratio. What it does
      say is that the direction points away from graph expansion rather than toward it
      **Decided before the next data arrives, so it cannot be a number chosen to be met:** revisit
      multi-hop when the trail holds **≥200 `inject` rows from real agent sessions** and
      **anchored + briefing ≥ 40%** of them. Until then the answer is not "we don't know", it is "the
      workload we can see does not ask for it"
- [x] **A gold set, and retrieval metrics over it** (recall@k, nDCG) — done in v5.5 below. The answer
      to "how often does RRF degenerate": on every question-shaped query in the set
- [x] **Multi-hop traversal and global aggregation** — done in v5.7 below. The gate above was
      **circular and is retired**: workload composition measures *adoption*, and adoption of a
      capability that does not exist is necessarily zero. Nothing is in service, so there are no users
      generating anchored injections, which are the thing multi-hop would deepen. That gate is sound for
      choosing between built capabilities competing for one corpus's traffic; as a gate on building one
      it always answers no. The trail stays instrumented for the question it can answer — once both
      shapes exist and are reachable, it says which ones people use
- [x] **Identity resolution across sources** — done in v5.6 below. Note the premise was wrong in a way
      worth keeping: Slack and GitHub store the author as an attribute string and mint no `person` at
      all, so it was never "three records" — it was one plus two opaque strings. `same_as` resolves the
      duplicate-record half (two RDB mappings, a mapped person beside a hand-filed one); minting a
      person for an unrecognised handle is a policy this repo still does not have, and refuses to invent

## v5.5 — the read paths stop paying per row

- [x] **Batch point reads (`getEntities`)** — every read path in core was a loop of `getEntity`, which
      costs nothing on sqlite and is a network round trip per iteration on a remote backend. Measured
      against the live OpenSearch demo with one script on both sides of the change, identical results
      throughout: a briefing **56 → 2** round trips, query injection **63 → 4**, `similar(k=60)`
      **61 → 2**, bulk `verify` of 54 ids **217 → 164** (its read half 54 → 1; the rest are the
      append-only writes). Optional capability with a core-side fallback, so a backend correctly declines
      it. `similar` was the largest of these and the newest: v5.3 put it on every query injection with
      `k = limit × 3`, and each hit was a point read: `similar` had been batched on one backend all
      along, and the contract had not noticed
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
      It had survived being erased from a live remote backend only because the scratch files were
      still there

- [x] **The graph routes stopped paying per author** — an anchored open at depth 3 made 1,715 port
      calls, of which **1,595 were actor-name resolution**: one point read per distinct author, twice
      over, because the entity and relation serializers each built their own memo. The traversal
      everyone would have blamed was 117 of them. A memo helps only when authors repeat and in a real
      corpus they do not. Now one batch read per response, shared: **122** calls, byte-identical
      response. Against live OpenSearch, depth 2 went **489 → 65** round trips and depth 3 became
      possible at all — the old shape's request storm failed the server before it answered

## v5.7 — the two question shapes graph retrieval wins on

docs/RESEARCH.md §5 named three shapes where graph retrieval measurably beats vector RAG: multi-hop,
temporal, global aggregation. Temporal shipped in v5.2 as as-of injection. These are the other two.

- [x] **Multi-hop anchored injection** (`inject --depth n`, `yoke_inject { depth }`) — a `decision`
      carrying `supersedes` is a multi-hop record by construction, and "what replaced the thing that
      replaced this" was answered with silence. Distance grades what anchoring already made binary:
      candidates are banded by hop distance and fusion still owns the order within each band, so a
      deeper walk adds context instead of displacing the subject. Depth 1 is byte-identical to v4.0.
      Measured on the 517-record demo corpus from one collaboration: depth 1 → 29 records in **1**
      `neighbors` call, depth 2 → 37 (57 reached) in **49**, depth 3 → 50 (70 reached) in **58**,
      depth 4 → 131 (207 reached) in **71**. Depth 4 is 26% of the corpus, which answers how deep is
      useful: past 3, everything is context and therefore nothing is
- [x] **Two rules had to generalise, and one of them was a latent bug** — v4.0 skipped the
      `authored_by` edge leaving *the anchor*. At depth 2 the un-generalised rule hands an agent the
      author of every neighbour, which is exactly the roster problem `membership: true` exists to
      prevent, arriving through a relation type nobody marked. Now skipped leaving any node. Membership
      is skipped at every hop on the same rule as depth 1
- [x] **The walk is bounded and never silently** — `WALK_BUDGET = 128` expansions, breadth-first so a
      cut always removes the farthest band, frontiers expanded in id order so a truncated walk is
      reproducible rather than dependent on relation order (invariant 2). `inject` returns
      `walk: { depth, nodes, truncated }` and the front tiers turn it into words, because an agent that
      reads a budget-truncated walk as the whole neighbourhood answers from part of the graph
- [x] **Global aggregation** (`yoke overview`, `yoke_overview`) — the question no `inject` can answer at
      any limit, because retrieval returns a top-k of a query and this is about the shape of the whole.
      Structure, never a summary: GraphRAG answers this shape by LLM-summarising communities, and a
      summary of knowledge is a claim nobody verified. Type/status counts by **effective** status (so
      the gap between "stored verified" and "injectable today" is finally one number — 132 of the demo
      corpus's 517 records are stale), a relation census, the most-connected records, and the authors
      of verified knowledge
- [x] **Two defects the tests caught before shipping.** Authors read from `provenance.actor` ranks
      **reviewers**, because `verify` replaces provenance — in a corpus with one reviewer it credits
      everything to that person. Now counted off the `authored_by` edge, which is also what
      `personaQuery` anchors on, so an overview naming persona candidates and a persona built from one
      cannot disagree. And degree counting `authored_by` puts **people** at the top of a list meant to
      say what knowledge clusters, since every record has exactly one author edge — excluded from
      degree, still in the census
- [x] **Aggregation memory is O(ids), not O(corpus)** — holding every entity so the hub list could
      carry full records costs **511 MB of RSS** at 1M entities / 3M relations, a read whose memory is
      the size of the corpus, which is the class docs/SCALE.md holds five of. Only `top` are
      ever returned, so they are re-read by id in one batch call. **420 MB**, and 29 ms / 5 pages
      on the demo corpus against 12.2 s / 8,010 pages at 1M. Stated ceiling: the id sets are still
      O(entities), so 10M needs counting in the backend rather than in core
- [x] **The demo corpus was unusable over MCP** — `scripts/load-demo-corpus.mjs` never seeded the
      `yoke:system` bootstrap actor, so `yoke mcp` refused the database it produced with "not
      initialized" while the CLI and web UI read it happily. Found by pointing a real MCP client at it,
      which is the only surface that checks. The loader seeds it now, idempotently

## v5.6 — a question stops being an unsatisfiable conjunction

- [x] **Long queries are a disjunction** (SPEC search clause 8) — `search` required every query term,
      which is right for the two or three someone types into a wiki and wrong for a sentence. Past
      three tokens a record now matches on any term and clause 6's ranking decides what the caller
      sees. Over the gold set, on sqlite: recall@10 **15.2% → 58.5%**, nDCG **14.1% → 45.8%**,
      accuracy@1 **13.6% → 37.9%**; the question-shaped cohort went from **0 of 91** relevant records
      found to **41 of 91**. The keyword-shaped cohort did not pay for it — **90.9% → 95.5%**, because
      a four-term keyword query was hitting the same wall. Confirmed on live OpenSearch: 58/109 found
      on both engines, identical accuracy@1
- [x] **The rule lives in one place** — five adapters and the in-memory fake had each inlined
      `qTokens.every(...)`, so the semantics were six copies of a decision the contract stated once.
      The new conformance case caught the sixth immediately: the fake kept passing the strict half
      after every real adapter had moved on
- [x] **The keyword half of RRF carries weight 0.1** — clause 8 improved every keyword-only number and
      quietly cost the *hybrid* path **12 points of accuracy@1** (65.2% → 53.0%), because rank-based
      fusion had no way to know that a disjunctive keyword list's rank 1 is worth less than a vector
      rank 1. Found by the gold set scoring both columns on every run, not by a report. Swept rather
      than chosen, and the top is a plateau; at 0.1 the hybrid path ends up **above** where v5.5 left
      it (recall 87.2 → 88.4%, nDCG 74.3 → 76.1%) with the keyword-shaped cohort untouched at 100%

- [x] **A lookup is not a question** — clause 8 charged the connector idempotency probe 8x. It searches
      for one exact `external_id` (a GitHub comment URL is ten tokens) and then filters for it exactly,
      so the disjunction made it score every record sharing the word "github": **34 ms and 0 rows → 292
      ms and 1,000 rows**, per ingested item, at 1M entities. Correctness held, which is what would have
      kept it quiet. `TextQuery.terms: "all"` restores the conjunction for callers that are looking
      something up, and the probe drops to **3 ms**. Not fixed with a heuristic in the caller: probing
      by "the id's most distinctive tokens" drops the discriminator (`file:notes/2026-07-01.md#3` loses
      the `#3`) and a probe that silently misses re-ingests the record
- [x] **One person, several records** (`same_as`) — two source systems describing the same colleague
      produced two `person` records and nothing said they were one, so a persona built from either was
      half that person's judgment presented as all of it. The link is knowledge, not config: an ordinary
      `yoke link <alias> same_as <canonical>` through the gate, versioned and reversible, needing no new
      command. Followed both ways and transitively (a direction that changed the answer would mean two
      accounts of one person), namespace-filtered before following, and marked `membership` so a
      briefing never hands an agent the person's *other record* as a finding. No fuzzy matching, for the
      reason `github-pr` already refused to guess a login → person mapping

What made the disjunction safe was that ranking arrived first, in v5.1. While `search` returned
storage order, the AND was the port's only precision and loosening it would have handed an agent the
oldest N records containing any one word. Two clauses in the same file, two releases apart, where the
second retired the first's reason for existing.

Left standing deliberately: **there is no batch form of `getEntity(id, version)`**, so `listVersions`'s
fallback — and as-of injection through it — is still a loop. Versions are a dense 1..n and a governed
record has two or three, whereas the loops closed above scale with the corpus. Nothing has measured it.

## v5.8 — a record's basis, and reading a snapshot back

Read across from Cloudflare OS (2026-08), whose one transferable idea is not its permission model but
**observation propagation**: track what an agent read, carry it with the output, re-verify it when the
output is opened. We already had the first half twice over — `inject` and `persona` both log the ids
they returned — and neither half was ever read back. Both items below close the loop from a different
end, and neither needed a storage-port change.

- [x] **`derived_from`, a seed relation type** — the audit trail records the read and the write as two
      events with no join key, in per-client local sqlite that `neighbors` cannot traverse and that does
      not move with the record between backends. An edge does. Filed at the **front tier** as an
      ordinary gate-passing commit, which is where this repo already put the `scope` link and wrote down
      why: `conflicts_with` is inside the gate because it derives from the content, a derivation is
      caller-declared. **core/commit.ts is unchanged.** Caller-asserted like `provenance.actor` —
      lenient on write — and never inferred from the trail, because an agent that injected 50 records
      and wrote one decision did not derive it from 50
- [x] **Deprecating names what rests on it** — the stale queue's lesson one surface over: flagging decay
      does not repair it, handing it to the thing that has to change does. `downstreamOf` (one incoming
      hop, ns-filtered) and `yoke deprecate` prints the records, not a count, because "3 records" routes
      nobody. Breaking: `deprecate --json` is `{ deprecated, downstream }`
- [x] **Not `membership`, and measured rather than assumed** — the evidence under a decision *is*
      knowledge, so the anchored walk should reach it. Depth 1 is byte-identical: a derivation edge joins
      two records and touches no anchor, so it is first followed at depth 2. persona cannot reach one at
      all, and the operative reason is the graph's shape rather than a flag someone has to remember —
      a one-hop walk from a *person* meets no record → record edge
- [x] **`yoke persona --check <SKILL.md>`** — SPEC said from v1 that the export records source versions
      "so a stale snapshot can be identified", and nothing could read them, so identifying one meant a
      person diffing two files by eye. Another clause written and never built — the stale queue (v5.2)
      was the same find, and SPEC labels it that way in its own heading. Six verdicts ranked
      most-actionable first, one per source since the remedy for every non-`ok` is the same re-export.
      **Exit 1 when any
      source moved**, which is the whole point: a snapshot that names its sources is only worth the bytes
      if something other than a person can read them
- [x] **The parser lives beside the writer, asserted by a round trip** — a format the two halves
      disagree about is the failure mode of every snapshot. An unreadable token is reported, not dropped:
      a source that cannot be read is not a source that is fine

The `superseded` verdict outranks `outdated`, and the test proves the ranking rather than the branch —
the fixture's version is *also* moved, so killing the supersession lookup produces exactly `outdated`.
Checked by killing it: that is the failure message.

- [x] **Every retire path reports it, web included** — parity is a floor on BOTH surfaces, not just a
      ban on a screen doing what the CLI cannot: this is the *governance workbench*, and hosting the act
      while dropping the answer that makes it a repair is the same defect facing the other way.
      `POST /api/deprecate` → `{ deprecated, downstream }`, rendered by **one** component across the
      entity, review and conflicts screens, so a fourth deprecate button cannot be added without it.
      WEB-UI.md states the floor. `/api/verify` keeps its array
- [x] **`/api/deprecate` had no test at all** — none, in `ui.test.ts` or `serve.test.ts`, while
      `/api/verify` had five. Which is how a response-shape change could have shipped unnoticed, and is
      its own finding: the untested route was the one performing the destructive half of the lifecycle

Left standing deliberately: **one hop, not the transitive closure — and that is now measured, not
provisional** (`eval/derivation-closure`, 2026-08-07). Three blind-generated team corpora, 15
deprecation events, semantic ground truth: zero truly-invalidated records at graph distance ≥ 2, so
the closure would have raised invalidated-recall by exactly nothing while adding the only noise in
the experiment. The binding constraint is **citation coverage** — 52% of genuinely-affected records
had no `derived_from` path at all — which no walk depth fixes. Agents do populate the field when
handed the tool (measured 3/3, one session earlier), so coverage grows with use; re-run the harness
against a real corpus once one has history worth labeling.

## v5.9 — the supported set, and configuration

- [x] **Only selectable backends are carried.** A backend is supported when `openStore` resolves it
      and it passes the shared conformance suite against a real server.
      Two adapters reachable only as a `--shards` member entry were dropped — that is a federation
      detail, not a way to run yoke — which also took a 531 MB native binding, a second `npm test`
      stage and a CI job with them. `conformance-cases.ts` stays split from `conformance.ts` because
      the opensearch suite imports the cases directly to gate on a reachable server
- [x] **`ShardKind` is one value.** `"sqlite"`, with the dynamic imports and kind-specific fields the
      union carried gone. The field stays because the router supports heterogeneous mixes; there is
      nothing to mix until a second shardable backend exists
- [x] **`.env` in the working directory**, via `node:process.loadEnvFile` — no dependency, no parser of
      ours. `--env-file` was rejected because Node 20 hard-errors on a missing file while
      `--env-file-if-exists` needs 22.9; `engines` moves to `>=20.12`, which is what the API costs.
      Loaded at the **`isMain()` entry only**: `runCli(argv, env)` takes its environment as a parameter,
      so loading inside it would mutate the real process for a test that passes a fake — and the suite
      must never pick a `.env` up, because `YOKE_TEST_OPENSEARCH_URL` names a cluster whose indices it
      DELETES and one forgotten line should not be able to do that on `npm test`. `.env.example` is
      committed and lists the product variables; the test variables are excluded, with that reason written where
      someone would otherwise add them. Measured: an existing environment variable is NOT overwritten,
      so a shell export or a CI secret always wins — pinned by a test, since a hand-rolled parser
      would break the promise silently
- [x] **A command reports the store it actually opened.** `--db` names the local sqlite whatever the
      backend is, so the human line names the resolved store (`shards cfg.json`, or the remote URL with
      the local file holding the audit half) while `--json` keeps `db` a path and adds `store`

`core/rank.ts`'s `rankByRelevance`/`matchesTokens` have no production caller: every supported backend
ranks `search` with a native index — postgres included, whose adapter builds a native `tsquery` from
core's own tokenizer. The BM25 is exercised only by the conformance suite's in-memory fake. Kept: the
port declares "best match first", the fake is where that is checked with no engine involved, and the
next adapter without an index of its own will need it.

`getEntities` and `similar` stay optional on the port, and `core/backfill.ts`'s no-vector branch stays
with them. Not hypothetically: sharded has **no `getEntities`** and exposes `similar` only when a member
does, so core's `getEntity`-loop fallback is live code on one of the four selectable stores.

## Doc/code consistency audit

Six parallel reviewers swept every document against the code, both directions. Most findings were the
documents' and were fixed in place. These were the code:

- [x] **`verify`/`deprecate` partially applied a refused batch** — the unknown-id check sat inside
      the write loop, so ids ordered before the bad one were already promoted when it threw, while
      both SPEC and the function's own header claimed refuse-before-write. Two-phase now; the new
      test is mutation-checked: reverting the fix fails exactly it
- [x] **`GET /api/inject` defaulted EVERY call to 50** where SPEC says the briefing alone is capped
      and the preview is byte-for-byte what an agent receives. It now applies the same
      `limit ?? (briefing ? BRIEFING_LIMIT : undefined)` as MCP and the CLI, takes `depth`, and
      returns `walk` — proven with 51 matching records
- [x] **serve's `/mcp` read its body unbounded** with no content-type check, on the one surface that
      can face a non-loopback interface, while SPEC's "bounded input" claims every route. Same
      256 KiB cap and check as the UI handler
- [x] **CLI `overview` wrote no audit row** while the MCP tool did — the exact per-adapter drift the
      audit-action table exists to prevent. It writes the same row now
- [x] **Four tables rendered knowledge without its citation** (graph nodes, collaboration
      list/members/attached, entity relations) while WEB-UI.md claimed the type system made that
      impossible. Citation columns added, the false mechanism rewritten, and a source guard
      (`citation-render.test.ts`) now fails any screen that shows a record without a source — with a
      named exemption list and a dead-exemption check

Two more, found by following the audit's own leads rather than reported by it:

- [x] **A namespace owned by a non-default shard was unusable** — `yoke init` seeds the shared
      (null-ns) ontology onto the default shard, and `ShardedStorage.loadOntology(ns)` read the OWNER
      shard alone, so every namespaced command died with "not initialized: … — run 'yoke init' first"
      while the identical commands worked on plain sqlite. That divergence is the tell: sqlite has
      always overlaid tenant defs on the shared base (PLAN-V2 10.1), so one backend answering
      `loadOntology(ns)` differently was backend behaviour leaking through the store surface. The
      router overlays. Worth noting how it survived: a test asserted the owner shard alone, and the
      CLI test hand-seeded a tenant ontology instead of running `init` — so the flow every real user
      takes was the one flow nothing exercised. Mutation-checked against three new tests
- [x] **`yoke init --shards cfg.json` reported `initialized: ./yoke.db`** — a file it had not touched,
      in the human line and in `--json`. One `storeLabel()` now names what was actually opened,
      including a remote backend's two halves (`http://…:9200 (audit + tokens: ./yoke.db)`)

Recurring shape worth remembering: **counts in prose rot fastest** ("10 of 12", "three tools",
"eight screens", "all five backends" — every one was wrong), and a claim is only as durable as the
test that pins it.

## v6.0 — postgres replaces neo4j

- [x] **storage-neo4j removed.** Its differentiator did not survive the consistency audit: the pitch
      was native FTS + vectors + graph in one engine, and the adapter never traversed natively — it
      stored relations as nodes, so the graph half was an indexed lookup structurally identical to
      sqlite's. What remained (native scored FTS + native vectors) OpenSearch already provides with no
      dependency, where neo4j cost a 3.8 MB Bolt driver. A graph-DB adapter that is not graph-native is
      a promise the codebase cannot keep; keeping it honest would have meant a storage-format migration
      (real Cypher relationships + a `walk` port capability) with zero deployments asking for it
- [x] **storage-postgres built**, against the database most orgs already run. **No new dependency** —
      `pg` has been in the tree since the RDB read-mapping connector. Native scored FTS: core's own
      `tokenize`/`requireEveryTerm` build a prefix `tsquery` (`simple` regconfig, so the Korean-suffix
      conformance case holds natively), ranked by `ts_rank`, with the searchable `tsvector` carried
      only by each record's latest version. `similar` is pgvector, and on a server without the
      extension the capability is genuinely absent (type-only `declare` fields, so `"similar" in
      store` answers honestly) rather than present-and-broken
- [x] **Same composite split, one new branch.** `YOKE_POSTGRES_URL` (+ optional `YOKE_POSTGRES_SCHEMA`)
      selects it; audit + tokens stay in the local sqlite; naming two remotes is an error. The adapter
      satisfies the structural `RemoteStore` shape with no change to the composite, the port, or
      `openStore`'s structure — the second time that claim has been tested, which is what "structural"
      is supposed to mean
- [x] **Isolation is a schema name.** All tables live in one caller-named schema (default `yoke`);
      the test suite creates and drops `yoketest_*` schemas only, so it can run against a shared
      database. CI drives the full suite against two real servers — pgvector for everything, plain
      postgres so the no-extension path is never only skipped
- [x] **Nested agent worktrees are excluded from the outer test run** (`.claude/**` in
      `vitest.config.ts`) — measured: without it, `npm test` picked up an in-progress worktree's copy
      of the suite (1,156 tests instead of 542) with cross-fork mock leaks as bonus failures

## v6.1 — the queue orders by consumption, and persona gets its eval

Two ideas worth keeping from a competitor survey (TencentDB Agent Memory), translated into yoke's
shape rather than imported:

- [x] **The stale queue orders by what agents are actually fed.** Every `inject`/`persona` audit row
      already names the ids it returned, so the count is an aggregation, not new bookkeeping —
      `consumptionCounts` + `rankByConsumption` at the front tier, core untouched. Both surfaces
      carry the answer: `yoke review --stale` prints `injected Nx` and sorts, `/api/review?stale=1`
      returns `injections` per row and the web table grew an optional trailing column (a prop, not a
      fork, so the citation guard keeps covering it). Human reads (`inject_preview`/`read`/`search`)
      deliberately do not count. ceiling: within-page ordering — the scan cursor pages by position;
      a globally-ranked queue needs the whole scan first, and no corpus has earned that yet
- [x] **Persona quality is measured** (`npm run eval:persona`), the way injection quality has been
      since v1.0: five planted failure modes (foreign authorship, `relates_to` association,
      `derived_from` sources, own drafts, own aged records), impersonation/draft-leak/stale-leak
      rates at 0% and whole/query recall at 100%, non-zero exit on any miss. Query recall counts
      precision too — exactly one record, the right one — so a filter that stops filtering fails as
      loudly as one that empties the persona. Mutation-checked: including drafts reads as 100% draft
      leak, dropping `scopeRel` as 50% impersonation

## v6.2 — a working context reaches a session that is already running

- [x] **`inject --since <ts>`** — only records whose current version began after the instant, judged on
      the clock the as-of rewind reads (`versionTime`). Before the cap; not counted as withheld
- [x] **`inject --scope <id> --unseen`** — the read a client-side hook makes between an agent's tool
      calls: records this context handed this client that have since changed (retired, rewritten —
      "re-check with the user"), then what is new since the last anchored delivery, minus versions
      the client already holds from any other read. Silent and row-free when there is nothing, so
      the bound stays put. The answer is in the client's own audit trail (`deliveries`, the rows
      `consumptionCounts` reads) — core untouched beyond `since` and `InjectItem.supersedes`. A held
      record replaced or contradicted by a newcomer is reported off the newcomer's own edges, so the
      reversal path (new decision + `supersedes`) is caught with no extra read. Measured: 110–130 ms
      per call on sqlite including node startup — CLI only; `--unseen` is not on the HTTP API.
      ceilings: an edge recorded later between two records both already handed is not seen; the
      ledger is per client, so two concurrent sessions in one context on one machine share it (a
      session column on the audit row is the fix, not a second ledger)
- [x] **The ledger is the reader's, wherever its deliveries are.** Under a shared Postgres the CLI
      reads the client's own trail; under `yoke serve` every client's rows are on the server, so the
      hook asks `GET /api/inject?scope=&unseen=1` — the same `unseenReport`, bounded by this token's
      rows only, `text/plain`, `204` when quiet, audited as `inject`. Verified: two tokens on one
      server each get their own briefing, and a second call answers 204
- [x] **The hook is docs, not code** (ADOPTION.md §3): `SessionStart` briefs, `UserPromptSubmit` and
      `PostToolUse` run `--unseen` (or the `curl` above on a team server); only `PostToolUse` needs the
      `additionalContext` envelope, because Claude Code feeds plain stdout to the model on the other
      two and not on that one
- [x] **The line's wording is what makes an agent stop, and it is measured** (2026-09-10, real
      `claude -p` sessions with these hooks installed, Opus 5, N=1 per case). Delivery reaches the
      model: briefed with "PG는 토스페이먼츠", the agent implemented Toss. Reversed **before** it wrote
      anything, it named both ids and the supersession and went on with the new decision — right, since
      nothing was sunk. Reversed **after** the Toss implementation was on disk, it stopped, left the
      file untouched, reported the change and asked, giving its reason as the line itself: *"훅이
      're-check with the user before building on them'이라 명시해서, 나이스페이로 갈아엎지 않고
      멈췄습니다."* So **do not harden that line into "always stop"** — it is what splits the two cases
      correctly, and a stronger instruction would stall the case with nothing to lose. Not measured:
      interactive mode (print mode has nobody to answer), other models, repetition

## v6.3 — what is said about the knowledge lives on the knowledge

- [x] **A retirement's reason rides on the retiring version** (`provenance.reason`), not on the audit
      row. The trail is one place under `yoke serve` and one sqlite per client under a shared
      Postgres/OpenSearch — so a reason on the trail was visible to every client in one deployment and
      to the retiree alone in the other, for the same `yoke deprecate --reason`. The rule that
      settles it: the trail carries pointers (who, when, which ids), never content. `retirementOf`
      became a pure function of the record (the namespace-wide trail scan and its ceiling are gone),
      `verify` does not carry a reason forward, the gate strips one, and the audit `note` column has
      no writer or reader. Verified against two clients of one Postgres: the reason the first client
      recorded is what the second reads

## v6.4 — the decision's author is its verifier

- [x] **`yoke_record_decision(verify: true)`** — when the person who owns a decision states it and
      confirms the filed wording in the conversation, the agent files and promotes it in one call: the
      gate writes v1 as a draft, `verify` writes v2 with `transitioned_at`, the trail gets the same
      `verify` row the CLI writes, under the author. Gated by `authorize("verify")` and checked before
      any write, so a refused caller is left with no stray draft. `yoke_commit` has no such switch: a
      fact's truth does not come from its writer, a decision's does. This closes the longest gap in
      the loop — a decision reached in a meeting used to wait, as a draft, for someone to open a
      terminal — and with `--unseen` on the receiving side a PO's "이렇게 결정됐어" is in every running
      session on the scope at the next tool call

## v6.5 — the harness ships as a Claude Code plugin, from this repo

- [x] **`plugin/` + `.claude-plugin/marketplace.json`** — the three hooks (SessionStart briefing;
      `--unseen` on UserPromptSubmit plain and PostToolUse enveloped), the yoke MCP registration, and
      a `/yoke:setup` skill that binds a repo (`.claude/settings.json` `env.YOKE_SCOPE`) and proves
      the wiring. Client-side packaging, not a third front adapter: every byte of knowledge moves
      through the CLI the hooks spawn (invariant 3). The hooks' hard rule — never break a session:
      missing scope, missing binary (`YOKE_BIN` overrides), unreachable store are all zero bytes,
      exit 0; pinned by `plugin/harness.test.ts`, whose e2e (brief → quiet → reversal enveloped per
      event, reported once) runs the real CLI via tsx. Distributed independently so a downstream
      harness can take it as a dependency instead of owning knowledge delivery itself

## v6.6 — the credential a non-interactive client can get by itself

- [x] **`POST /api/login/github`** — a GitHub token in, a yoke token out (`github:<login>`, read+write,
      +verify per `YOKE_GITHUB_VERIFIERS`). Enabled only under `--auth` with `YOKE_GITHUB_ORG`; org
      membership is the access decision; the presented token is spent on two lookups and never kept;
      GitHub down answers 502, not 401. Re-exchange replaces, so revocation self-heals client-side and
      the durable levers stay GitHub's own
- [x] **`plugin/hooks/auth.mjs`** — the zero-action client: cache → `gh auth token` → exchange, one
      announce line when a credential actually moves, silence otherwise; `YOKE_SERVER` bound in repo
      settings switches both hook entrypoints to the server read with 401 self-heal. Verified end to
      end in-suite: real `serve --auth` + a GitHub double + a fake `gh` — exchange announced once,
      delivery, PO reversal with reason over HTTP, server-side revocation healed without a touch.
      ceiling: no server-side text briefing yet, so a serve-bound SessionStart re-briefs only what the
      token was never handed; the MCP `yoke_inject` covers in-session re-briefing

## v7.0 — born verified: the gate moves from the door to the lease

Reverses a founding rule, decided 2026-09-11 after surveying how OpenClaw, Hermes Agent, mem0,
Zep and AiKA capture knowledge: every capture system in production is opt-out (post-hoc
correction), and the pre-use approval queue was our adoption cliff — a corpus stuck in draft is a
product that looks dead, and confirmation prompts are friction at exactly the moment capture must
be free. What made the flip safe HERE is machinery none of those systems have: signed provenance
bound to the credential, TTL expiry that composts what nobody re-confirms, disputes served
marked, and the `--unseen` ledger turning a retirement into a recall notice that chases every
delivery. Approval on entry was protecting readers with the weakest of the five mechanisms.

- [x] **`Status = verified | stale | deprecated`** — `draft` leaves the vocabulary; the gate births
      records verified (single v1, `last_confirmed` = entry). `verify` is re-confirmation: it
      refreshes the lease and revives a retired id. Relations have no lifecycle at all.
- [x] **Injection unchanged where it matters** — verified-only, stale/deprecated never served,
      `includeDraft` deleted rather than defaulted.
- [x] **`yoke review` IS the stale queue** — the draft listing, `--stale`, `--all-drafts` and
      `--include-draft` are gone; the human surface is re-confirmation and retirement, ordered by
      what agents actually consume.
- [x] **RBAC collapses to read / write / admin** — committing, re-confirming and retiring are one
      trust level (`write`), because the checks live downstream of the act; ontology migration and
      `rename-type` move to `admin` (they change what types mean — operating, not recording).
      `YOKE_GITHUB_VERIFIERS` is deleted: org membership mints `read,write`, membership is the only
      tier.
- [x] **`yoke_record_decision` loses `verify:`** — a decision is live at birth like everything
      else; the owner's-confirmation ceremony existed only to cross a gate that no longer exists.

## v7.3 — the session-end flush, measured and not shipped

The plan (캡처와 계측 로드맵) named three candidates for recovering knowledge an agent failed to
file in-band — a Stop-hook one-time block, a PreCompact instruction, a per-prompt reminder — and
said the experiment decides. It decided against all of them.

- [x] **Measured, 12 runs** (claude -p, sonnet, CC 2.1.268; two scenarios × 3 control + 3 Stop-hook
      runs; a fresh store per run, the MCP instructions as the only in-band pressure; judged by
      which of 3 planted learnings landed as records). Scenario 1 states the learnings outright;
      scenario 2 buries them in a config-repair task where filing competes with real work.
      **Control captured 18/18 with zero noise in both.** The in-band knowledge loop is not the
      weak link this hook was designed for — not on this model, at this session length.
- [x] **The Stop-hook flush recovered nothing and manufactured records.** Recall delta 0/18; in one
      run of six the flush prompt produced a meta-fact about the working repo and a second,
      contradicting decision filed with a conflicts_with edge — an invented dispute, delivered to
      the scope like any other record. Plus one extra model turn per session, every session.
      A nudge aimed at an agent that already filed everything has nothing left to elicit except
      invention.
- Nothing ships. The hard rule that hooks never break a session survives untested against blocking,
  because nothing earned the block. ceiling: single-turn -p sessions — a days-long session that
  compacts repeatedly is the case this harness cannot reach (the PreCompact candidate is untestable
  in it outright), so if `audit --pulse` ever shows live hands-free capture density LOW while
  session counts are high, re-run this against long transcripts before concluding the same.

## v7.4 — the merge button is the capture moment

- [x] **A merged PR is a decision** — `connect github-pr` yields one decision per merged pull
      request: title as conclusion, body as rationale (quoted and bounded, never summarized —
      a connector inventing a conclusion would be writing knowledge nobody recorded), the merge
      instant as the event time, `pr:<repo>#<n>` as the idempotency key. The review-comment path
      stays; the listing walk is paged (measured before paging: 53 merged PRs, 28 captured).
- [x] **Measured on this repository**: one backfill command turned the repo's own history into 48
      merged-PR decisions + 3 review-comment records, zero duplicates on re-run. Precision of the
      merged-PR path is the merge semantics itself — every record is a change the team accepted;
      what varies is rationale density, which is the PR culture's property, not the connector's.
- [x] **The recipe is the deliverable** (ADOPTION §2): a 12-line workflow makes every future merge
      stream its own delta into the team server under a machine token. This repo has no persistent
      server to point it at, so the live wiring waits for a deployment — stated, not faked.
- Deferred: `relate`-proposed supersedes edges between captured decisions need the LLM relater
  (`YOKE_LLM_*`), which this measurement session did not run. Measure when an endpoint is up.

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified.
When market signals arrive (the first enterprise customer, the second org), the
ordering within v2/v3 can be adjusted.
