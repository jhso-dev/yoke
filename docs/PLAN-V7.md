# yoke — v7.0 → v7.6 implementation plan

Closes the five gaps a Spotify-Portal comparison exposed (surveyed 2026-08-17). Same global rules as
PLAN.md and PLAN-V2.md: task = commit unit, all four checks (`typecheck` · `lint` · `test` · `build`)
green per commit, ROADMAP checkbox updated in the same commit. Design contracts in ARCHITECTURE.md,
BACKENDS.md, ENTERPRISE.md, MARKET.md win on conflict.

The five gaps, and where each is closed:

| # | Gap | Closed in |
|---|---|---|
| W3 | Quality is self-defined: headline numbers unreproducible, governance eval runs on a stub embedder, precision unmeasured | v7.0 |
| W2 | Capture is the bottleneck: rituals prescribed, density not instrumented, verify friction unmeasured | v7.1 |
| W5 | The people model is shallow: no group, no org chart, stale routing dies with its author | v7.2 |
| W1 | Not a product, a piece: no catalog, ownership, docs index, scorecards, scaffolding — yoke grows its own **portal** | v7.3 · v7.4 · v7.5 |
| W4 | No ecosystem or distribution: the npm name is taken, no registry listing, connectors are in-tree only | v7.6 |

Order is dependency-driven: measurement first (every later claim needs a scoreboard that predates it),
then capture (the portal is worthless over an empty store), then groups (portal ownership resolves to
them), then the portal itself, then distribution (publish something worth installing).

v7.3 moves a documented boundary — WEB-UI.md currently forbids the portal's screens — so 7.3.1 amends that
document before any screen is written, which is the order that document itself demands.

---

## v7.0 — the numbers become reproducible

### 7.0.1 the harness lands where the number is quoted

`bench/` is absent from `origin/main`; the harness lives only on `bench/personamem-loop` (pushed, 105
commits behind main). Cherry-pick the directory — `yoke_provider.py`, `fullcontext_provider.py`,
`test_timeline.py`, `backfill-ordinal-dates.mjs` + test, `README.md`, and the dated result JSONs.

The branch's substantive `src/` work already landed on main via other PRs (raw connector, index-key
provenance, `occurred_at` preservation, the relate stub fix, the unread-chunk hole, the stdout flush fix,
`envKeywordWeight`). **Do not merge `2cfe8d3`** — an off-by-default unmeasured prompt variant is
speculative config, and subtracting it is the first principle.

DoD: `git ls-tree origin/main -- bench` is non-empty; no `src/` change in the commit.

### 7.0.2 the headline table names its harness and its limits

README's four-row table, the 5.2×/20× claims and the "~87% translated" figure name no harness, carry no
date, and link to no reproduction. Meanwhile `bench/README.md` — invisible until 7.0.1 — holds the three
caveats that decide how the number may be quoted:

- the provider runs `verify --all-drafts`, so the measurement is **yoke with the gate open**;
- extraction at concurrency > 1 is not reproducible even at temperature 0 (the same 39,154-char document
  yielded 27 / 25 / 18 records), so every arm score is a **single draw**, not a point estimate;
- the runner scores any arm with empty context wrong whatever it answered, so the no-memory floor of 0%
  is structural — re-scored it is 47.6% (20/42), and bm25's lift falls from "∞" to ×1.30.

Add to both READMEs, under the table: harness name and dataset (`vectorize-io/agent-memory-benchmark`,
PersonaMem, 2 users / 42 questions), measurement date, reader model, and one line pointing at
`bench/README.md` for what the number does not measure.

DoD: every figure in the table traces to a result JSON in `bench/`.

### 7.0.3 one command reproduces the table

`npm run bench` runs the four arms (`none` · `fullcontext` · `bm25` · `yoke`) with the rig pinned:
temperature 0, fixed seed, `SDE_CONCURRENCY=1`, `YOKE_EXTRACT_CONCURRENCY=1`. A rig change moves the
baseline, so the script prints the reader model and the pinned settings with the result.

DoD: two runs of the same configuration agree question-for-question (`results-p0-determinism-u2-repeat`
is the precedent).

### 7.0.4 the full set, at leaderboard conditions — **needs an answering endpoint**

42 questions over two users is a pilot. Run the full PersonaMem set (589 queries) with a frontier
answerer across all five arms, so the number sits beside the published leaderboard (cognee 81.8%,
hindsight 86.6%) instead of being extrapolated to it.

The extrapolation is already gone: 7.0.2 deleted the "~87% under official conditions" claim rather than
restating it, because it added a reader gap measured on one rig to a score from another, and this repo's
own frontier-reader run contradicts the premise. So nothing false is waiting on this task — what is
waiting is a *positive* number at comparable conditions, and `npm run bench` is the command.

DoD: all five arms over 589 queries with a frontier answerer, result files committed, README's tables
replaced by the single-rig set. Per 7.0.2 an arm is still a single draw, so report the extraction range
from three ingests rather than one number.

### 7.0.5 the governance eval runs on real vectors

`eval/inject-quality.ts` plants 50 synthetic records and embeds them with a stub whose vectors are built
from the planted topic word, which is why README has to admit the contradiction figure measures only that
stage 4 files the edge. Re-point it at the 30k-record corpus `scripts/gen-kraftonway-corpus.mjs` already
generates, with `bge-m3` behind `YOKE_EMBED_URL`.

DoD: contamination and missed-contradiction rates reported on real embeddings; the "stub embedder"
caveat is deleted from README because it is no longer true. If detection drops below 100% on real
vectors, **the number ships as measured** — that is the point of measuring.

### 7.0.6 precision, on both axes

README states plainly that precision is not measured. Add it: false-conflict rate (pairs linked
`conflicts_with` that are not contradictions) on the same corpus, and injection precision@k over
`eval/gold-set.json` beside the existing recall/nDCG.

DoD: the sentence "Precision is not measured on either axis" is replaced by two numbers.

---

## v7.1 — capture density becomes visible, and promotion becomes cheap

### 7.1.1 every adoption metric gets a runnable command

ADOPTION.md §6 names five metrics and gives a command for two. Fill in the rest from what exists:
`yoke audit --since <ts> --json` for weekly new `decision` by author, `yoke overview` for per-type
counts, `yoke review --stale | wc -l` for queue health.

If `audit --json` does not already carry (author, type, instant), add the fields to the existing
aggregate — no new command.

DoD: each row of §6 carries a copy-pasteable command; "weekly new decisions per role" is one line.

### 7.1.2 verify friction is measured before it is optimised

MARKET.md's stated risk — "if governance friction is expensive we look like a clunkier Mem0" — has never
been timed. Time a 20-draft review sweep, record it in ADOPTION.md §4 beside the weekly-sweep ritual.

DoD: a dated number in the doc. It becomes the before/after for 7.1.3.

### 7.1.3 batch verify, without erasing authorship

The review queue promotes one record at a time. Cluster the draft queue by the embedding neighbourhood
already computed for duplicate detection, and let one action promote a cluster — **per-record author
preserved**, because `verify --all-drafts` under one account overwrites head provenance and silently
disables persona and stale routing (ADOPTION.md §1 forbids it, and this must not reintroduce it).

Surface: the web UI review queue (v6.1 already orders it by consumption) and `yoke review --cluster`.

DoD: a test asserts each promoted record keeps its original author; the 7.1.2 measurement repeats lower.

### 7.1.4 two connectors where decision density is highest

The `Connector` contract is `name` + `pull(since)` returning `SourceItem`s, so each is adapter work:

- `yoke connect tracker --jira|--linear` — decisions argued in tickets and their comments;
- `yoke connect adr --glob 'docs/adr/*.md'` — ADR files already written in the repo, with `occurred_at`
  from the document's own date rather than the import clock.

DoD: each passes the connector ingest tests (idempotency by `externalId`, source-dated `occurredAt`,
drafts only).

### 7.1.5 nightly capture with no human in the loop

A documented cron that pipes the day's commit messages and agent transcripts through `connect raw`. No
new code — an example in ADOPTION.md §4, so density accrues without anyone typing.

DoD: the example runs end to end and lands drafts dated from the source.

---

## v7.2 — people, groups, and who is on the hook

### 7.2.1 `group` and `member_of` join the seed ontology

Add `group` (entity) and `member_of` (relation, `membership: true`) and `owns` (relation) to the default
ontology. The `membership` flag already exists precisely so a briefing does not hand the roster over as
knowledge — an anchored briefing must not start reciting the org chart.

DoD: an anchored briefing on a `collaboration` returns no membership edges as knowledge (existing
briefing test extended).

### 7.2.2 the org chart arrives from the identity provider

Under `serve --auth` the OIDC claims already carry groups. Map them to `group` entities and `member_of`
edges on login, so the chart is synced rather than typed. Local single-user mode is untouched — invariant
4 holds, the local path asks for no credential.

DoD: a login with group claims produces the edges; a login without them changes nothing.

### 7.2.3 stale routing survives its author

`review --stale` routes to the record's author. When that person is gone the record has no owner and ages
out unseen. Fall back to the author's `group`, then to the anchoring `collaboration`.

DoD: a record whose author has no active membership routes to their group in the stale queue.

### 7.2.4 `yoke owner <id>`

One command answers "who is on the hook for this" — author, group, owning collaboration, and the last
person who verified it. It is the question Portal answers structurally and yoke could only answer by
reading citations.

DoD: `--json` output carries all four, resolved to names, ids on request (never a bare ULID in the human
column).

---

## v7.3 — the portal, and the line it has to move

yoke gets a portal: a browser surface where a person sees what the org runs, who is on the hook, what is
documented and what has rotted. The competing product is Spotify Portal. The axis yoke wins on is the one
it already owns — **every row carries verification state and freshness** — so the portal is the catalog
seen through the gate, not a directory with a search box bolted on.

### 7.3.1 WEB-UI.md's line moves, in writing, before any screen exists

WEB-UI.md forbids exactly this. Its three tests admit a screen only if it "supports a governance act —
not 'look something up'", and the document requires the argument to be made in it *before* the code. So
amend it first, dated, with the reasoning and the new boundary:

- **Test 1 widens.** A screen may answer "what do we run, and who owns it" **when every row it renders
  carries the record's effective status, its freshness, and its owner chain.** A catalog that cannot be
  read without seeing what is stale and what was never verified is a governance surface; a catalog that
  hides that is the decay Backstage ships, and stays forbidden.
- **Tests 2 and 3 do not move.** No synthesis, no second ranker, no model call, no attribute editing, no
  write outside `commit()` as `draft`. The portal renders records, never answers — a question about the
  knowledge still goes to an agent over MCP.
- **What remains refused**, so the line is a line: no answer text, no prose summaries of a service, no
  chat, no authoring surface that edits an existing record's attributes, no second catalog for humans to
  keep in sync by hand.

Also drop "IDP" from the vocabulary of every doc — the category word is **portal**, and `IdP` stays
reserved for the identity provider in 7.2.2.

DoD: WEB-UI.md carries the amendment with its date and the refused list; the screens below cite it.

### 7.3.2 catalog types, as data

`service`, `api`, `datastore` entity types and a `depends_on` relation — declared through
`yoke ontology add-type`, so **core changes by zero lines**. They ship as a documented ontology fragment
loaded on demand, not in the seed: a knowledge database should not presume every tenant runs services.

DoD: the fragment loads on a fresh DB and the screens below work over it.

### 7.3.3 the catalog fills itself from the descriptors that already exist

Nobody types 200 services. `yoke connect backstage` reads `catalog-info.yaml` by glob or the Backstage
catalog API: Components/APIs/Resources → entities, `spec.owner` → `owns` edges against v7.2's groups,
`spec.dependsOn` → `depends_on`, TechDocs links → `resource` records. One more connector against the
`name` + `pull` contract, not a subsystem.

Descriptors come from a source that is already the org's system of record, so rows land **verified** under
the documented `connect rdb` exception (BACKENDS.md) — with one deliberate difference to state there: a
descriptor is only as fresh as its last PR, so these records take a TTL and surface in `review --stale`.
That is the catalog-decay fix, and it is the reason the portal is worth building rather than mirroring.

DoD: a fixture catalog of 20 components imports with owners and dependencies; re-import is idempotent;
imported records carry a TTL.

### 7.3.4 `/catalog` — the portal's front door

A table of what the org runs, ordered so the rot is visible: service, owner (resolved through groups),
dependency count, whether a doc `resource` exists, effective status of its knowledge, stale count.
Filters by owner and by "has stale knowledge". Backed by a new `GET /api/catalog` following the existing
route pattern in `src/front/ui/server.ts`, reading through core (`neighbors`, `aggregate`, `downstreamOf`)
with no ranking of its own.

The CLI keeps parity per WEB-UI.md §"Parity is a floor on BOTH surfaces": `yoke catalog [--owner g]
[--stale]`.

DoD: `--json` and the screen return the same rows; a service whose owner record is retired, unverified or
missing is visibly not green on both. (Staleness of the OWNER needs the owner type to declare a TTL — the
seed gives `group` none, so it is not part of this DoD; see the ceiling in core/scorecard.ts.)

### 7.3.5 a service reads as a service, on the page that already exists

Do not add a route. `/entity` already renders a record and its relations; give it a type-aware panel when
the type is one of 7.3.2's: owner chain, dependencies and downstream, doc resources, the most recent
verified `decision`, open conflicts, stale items. One panel, one API field, no second detail page to keep
in sync with the first.

DoD: `/entity?id=service:x` shows the panel; a non-catalog type renders exactly as before.

---

## v7.4 — documents, and a scorecard that cannot be gamed by silence

### 7.4.1 the wiki becomes indexed knowledge, not a second search box

`yoke connect confluence|notion` registers pages as `resource` records with source dates, and extracts
`decision`/`fact` drafts from pages that argue rather than describe (the `raw` extractor already does this
work — this is a source adapter for it, not a new front adapter).

The docs index is **not a new screen**: it is `/browse` filtered to `resource`, which already renders
typed, status-labelled rows. One filter beats one page.

DoD: pages import as resources; extraction produces drafts, never verified records; `/browse` filters to
them.

### 7.4.2 `/scorecard` — checks as queries, not an engine

Soundcheck is a rules engine. yoke needs none, because every fact the checks want is already in the
schema: does this service have a **verified** owner, a runbook `resource`, a `decision` inside its TTL,
and how much of its knowledge is stale? Four queries, one table, `GET /api/scorecard`, plus
`yoke scorecard` for parity.

The check no descriptor-based portal can run is the one that matters: **a service whose owner record is
stale is not green.** Absence and rot both score, so a service cannot pass by having nothing recorded
about it.

DoD: the scorecard over the 7.3.3 fixture flags (a) a service whose owner aged past its TTL and (b) a
service with no verified decision at all.

### 7.4.3 `/owner` — what a person or a group is on the hook for

v7.2 gave yoke groups; this is where they pay. A person or group resolves to: services owned, drafts
awaiting their verify, their stale queue, and the records that name them as author. It is the routing
screen for the weekly sweep and the expiry ritual (ADOPTION.md §4).

DoD: the screen and `yoke owner <id>` agree; a person with no active membership resolves to their group.

---

## v7.5 — "create a new service", without a template engine

A portal has a create button. This one does not generate files: the conventions live as verified
`decision` and `term` records, and the button hands the agent the injection that carries them — the same
machinery `persona` already is. The screen dispatches; the agent scaffolds.

That is not a smaller feature than a scaffolder, it is a longer-lived one: a template file rots silently
and nobody notices until the tenth service is wrong, while a verified convention expires and comes back to
its owner through the queue that already exists.

DoD: one transcript in which an agent creates a service to convention from injected knowledge alone, with
every convention it used traceable to a cited record. Screen code: a link and a copyable prompt. Generator
code: zero.

---

## v7.6 — distribution, and a surface others can extend

### 7.6.1 a name that can be published — **decision required**

`npm view yoke` is `sintaxi/yoke`, "preprocessor that does language agnostic concatenation", published at
0.1.3. The name is taken, so `npm i -g yoke` will never install this. Options: publish scoped
(`@jhso-dev/yoke`, binary still `yoke`), or rename the product. Meanwhile `package.json` says
`version: 0.1.0` for a tree that is feature-complete through v6.1.

DoD: a scoped or new name chosen, `version` matched to reality, `files`/`bin` verified against a `pack`
dry-run.

### 7.6.2 install becomes one line

README's install is a `curl | bash` that clones, builds and links. Replace it with `npm i -g <name>`,
keeping the script as the from-source path for contributors.

DoD: a clean machine installs and runs `yoke init` from npm alone.

### 7.6.3 registry listings

MCP registries are the discovery path the MARKET.md adoption ladder assumes and currently lacks.

DoD: listed, with the `.mcp.json` snippet the README already carries.

### 7.6.4 third-party connectors, without a plugin framework

`Connector` is `name` + `pull` — twelve lines that resolve a module by name from config make external
connectors possible with no core change and no framework. Third-party code produces `SourceItem`s and
still enters through the one commit gate, so invariant 5 holds.

DoD: a fixture connector loaded from outside the tree ingests through the gate; a module that does not
satisfy the contract is refused by name with the reason.

### 7.6.5 evidence, in public

A demo database anyone can query, plus this repository's own store as the first case: the decisions
behind yoke are in yoke, and the agent building it is injected with them.

DoD: `yoke overview` output on the project's own DB in the README, dated.

---

## Decided while building

1. **7.6.1 name — scoped publish.** `@jhso-dev/yoke` at `0.7.0`. The bare name is `sintaxi/yoke` on npm
   (a preprocessor, 0.1.3), and a scope keeps the binary, the docs and the ontology vocabulary unchanged,
   which a rename would not. Reversible: nothing outside `package.json` names the package.
2. **7.3.1 seed or fragment — fragment.** `ontology/catalog.json`, loaded on demand and shipped inside the
   package, because a knowledge database should not presume every tenant runs services. It made
   `add-type` take an array (a fragment is a set) and take a bare name (`add-type catalog`), so the
   refusals that tell people to load it name something a global install actually has.

## Still open, and why

- **7.6.2 / 7.6.3 — the first publish and the registry listings.** Outward actions, prepared and not
  taken: the package packs clean and `prepublishOnly` gates it on the four checks, but publishing is the
  owner's call. README's install still documents the installer script rather than an npm command that
  does not resolve yet.
- **7.0.4 — the full 589-query run.** Needs an answering endpoint. `npm run bench` is the command, and it
  refuses to start until the harness is pinned.

## What stays out, and why the portal is still whole without it

- **A rules engine for scorecards** (7.4.2 does it as queries) and **a template engine** (7.5) — both
  would add a subsystem to restate data yoke already holds.
- **A second place to author services by hand.** 7.3.3 imports the descriptors the org already maintains.
  A hand-kept catalog beside them is the decay problem, duplicated — and WEB-UI.md test 3 forbids the
  editing surface it would need.
- **Answers.** No prose service summaries, no chat in the portal. Every screen renders records; a question
  about the knowledge goes to an agent over MCP. This is the half of WEB-UI.md's line that 7.3.1 does
  **not** move.
