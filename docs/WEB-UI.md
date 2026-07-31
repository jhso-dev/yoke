# yoke — Web UI (v2.5 design, extended v5.0)

The web UI is a **governance workbench**: the human surface for deciding what yoke is
allowed to tell an AI, and for auditing what it told. It is not a place to read
knowledge as answers, and not a place to author knowledge.

## The line (read this before adding a screen)

Every screen renders **records, not answers**. A record is typed, versioned,
status-labelled and cited — shown as what yoke stores. An answer is prose synthesized
to satisfy a human's question; that is the AI's job, and yoke feeds the AI over MCP.

Three tests a screen must pass, argued in this document before the code exists:

1. **Governance purpose.** It supports a governance act — promote, reject, deprecate,
   trust, audit — or makes one auditable. Not "look something up".
2. **No synthesis.** No model call, no relevance ranking outside the injection ranker,
   no generated text. A screen that needs a model to produce its output belongs in MCP.
3. **No editing, and no bypass.** Writes go through `commit()` or a lifecycle transition,
   never straight to the store. Created records enter as `draft` like any other, carry
   `origin: "web"`, and are subject to the same gate. Editing an existing record's
   attributes from a screen stays forbidden. (Amended 2026-07-31 — the reasoning is at the
   end of this document; before that, creation was banned outright.)

**Why the injection preview is not the search UI we still refuse to build.** It renders
the *injection decision*, not a result set: the same filter, the same ranking, the same
citations, and the same audit row as a real `yoke_inject` call — and no answer text. A
search UI would exist to satisfy the human's question; the injection preview exists to
let a human check what the machine is about to be told, and to leave a record that they
looked. If a query box ever presents its results as an answer, ranks them with anything
but the port's own retrieval, or returns full attributes without an audit row, it has
become the search UI and must be removed. (Reworded 2026-07-31 — the sentence used to say
"returns knowledge `yoke_inject` would have withheld", which condemned `browse`. See the
second amendment.)

**Why browsing is not searching.** Navigation — entity → its relations → a neighbour, a
graph node → its detail — reaches a record we already decided to store. It makes the
*shape* of the knowledge visible: orphans, clusters, conflict pairs, what a scope anchor
would pull in. Retrieval-for-reading is what we refuse; reachability-for-governing is
the product.

## Screens

The governance set (v2.5):

1. **Review queue** — the draft list, with source and duplicate candidates shown, and
   bulk verify/reject. Reason for being: drive promotion friction close to zero
   (addressing MARKET risk 1). The core screen.

   **Constraint, for whenever this screen serves more than one reviewer: it must not show a peer's
   pending approval.** Seeing early approvals makes later reviewers converge on them without the
   group getting more accurate (`docs/RESEARCH.md` §2), and the anonymity that prevents it is the
   whole mechanism of a Delphi (§3). No such state exists yet — verify is immediate and per-actor —
   so this constrains a future design rather than describing a present protection.
2. **Conflicts view** — conflicts_with pairs compared side by side; deprecate one side
   or keep them coexisting.
3. **Ontology browser** — types and relations, with migration history.
4. **Persona preview** — pick a person → review the knowledge that would be injected →
   export the skill.

The viewing set (v5.0) — reading what is already stored, never adding to it:

5. **Entity detail** — one entity: attributes, every version, its relations, its
   authorship edge, computed freshness. The record as stored, nothing inferred.
6. **Injection preview** — a query (optionally scope-anchored) → exactly what `inject()`
   would return, with citations and effective status, audit-logged per preview.
7. **Graph explorer** — the entity/relation graph, force-directed, navigable from any
   node, bounded by the port's enumeration page limit and explicit about truncation.
8. **Audit log viewer** — the append-only audit trail, filterable by actor, action and
   time. The screen that makes "who was told what, when" answerable without shell access.

Added after the browser pass (2026-07-30):

9. **Collaboration** — pick a unit of work → see who is on it, what is attached to it, and the
   briefing an agent receives when it anchors there.

   Passing the three tests, as this document requires before the code exists:

   1. **Governance purpose.** It makes an injection auditable *before* it happens. v4.0 made a
      collaboration anchor first-class in core, MCP and the CLI, and there was no way to see what
      anchoring on one would hand an agent — the id was something you had to already know. The
      act it supports is "decide whether this working context is fit to brief an agent from",
      which is the same act the injection preview supports for a query.
   2. **No synthesis.** It composes three existing routes (`/api/entities?type=collaboration`,
      `/api/entity/:id`, `/api/inject?scope=`) and adds no endpoint. The briefing panel is the
      real `inject()`, so its ranking is the injection ranker and nothing else. No model call,
      no generated text.
   3. **No new knowledge.** Read-only. It creates nothing and edits nothing; the only mutations
      reachable from it are the lifecycle transitions its rows already offer via the shared table.

   **Why this is not a search UI.** You do not arrive by querying: you pick from the list of
   collaborations that exist, then read what is attached. That is the browsing argument above —
   reachability-for-governing — and the briefing panel is the injection-preview argument, applied
   to a scope instead of a query. It carries the same audit row (`inject_preview`) for the same
   reason.

A tenth screen requires the three tests to be argued here first.

## Design decisions

- Server: embedded in the CLI (`yoke ui` → a local HTTP server). In server mode the same
  UI is served remotely — not a separate artifact.
- Stack (v5.0): Next.js with `output: 'export'`, React, and `d3-force`. A build step is
  now allowed; a *server* framework is not, and `output: 'export'` is what keeps that
  honest — the build emits static files, the existing `node:http` server serves them, and
  there is no second process, port, or deployable. The two original conditions still
  bind: **one static bundle** (embedded distribution), and an API that is **only the HTTP
  exposure of core functions** — no UI-only business logic, so every action stays possible
  from the CLI too.
- Audit surfacing: across every screen, knowledge is always shown with its source and
  version. Enforced by the type system rather than by review — the shared row type makes
  the citation non-optional, so a screen that omits it does not compile.
- Bind address: loopback by default. `yoke ui` cannot authenticate, so widening it is an
  explicit `--host` and says so loudly; `yoke serve` refuses a non-loopback bind without
  `--auth`.

## What we don't do (still forbidden after v5.0)

- **A chat interface.** No conversational surface, no model call from the web tier, ever.
  Asking questions *of* the knowledge is the AI's job, over MCP.
- ~~**A search UI for human reading.**~~ **Narrowed 2026-07-31 — see the second amendment
  below.** A query box over stored records is allowed on `browse`, returning the same
  status-labelled rows the list already returns. What stays out is the part that was always
  the risk: results presented as an answer, ranking outside the port's own retrieval, and
  any model call.
- ~~**A knowledge-authoring editor.**~~ **Reversed 2026-07-31 — see the amendment below.**
  Creating records and relations is now allowed; *editing an existing record's attributes*
  and bulk import are still not.
- **Dashboard-style statistics.** Counts and charts nobody acts on. The eval report and
  CLI output cover measurement.
- **Server-side rendering, an API framework, or a second deployable.**
- **UI-only business logic.** Unchanged since v2.5: if a screen wants something the CLI
  cannot do, the answer is a core function and a CLI command, not a route.

## Amendment (2026-07-31): the web tier may create, and test 3 gets a definition

Test 3 read "**No new knowledge.** The only writes are lifecycle transitions on records that
already exist." That ban is lifted for creation. The reasoning, and the new line:

**What the ban was actually protecting.** MARKET's claim is sourced-only entry: knowledge
arrives from the work — an agent capturing a decision as it is made, a connector reading a PR
— rather than being typed into a box by someone looking at a dashboard. A form invites the
second, and its provenance would be "somebody typed this", which is the weakest kind there is.

**Why that does not require forbidding the form.** The gate, not the adapter, is what enforces
entry: `commit()` validates against the ontology and stamps provenance no matter which front
tier calls it, and *every* record enters as `draft` and needs a human `verify`. A record created
in the browser is subject to exactly the checks one created by an agent is. What the ban bought
on top of that was a guarantee that hand-typed knowledge could not exist at all — and that
guarantee cost the product something real: a `collaboration` whose roster could not be recorded
from the surface built to show it.

So the guarantee is replaced by a weaker but honest one: **hand-typed knowledge is allowed and is
labelled as such.** Web writes stamp `provenance.origin = "web"`, distinct from `cli`, `mcp` and
every connector name. A reviewer can see which drafts were typed by a person at a screen, and
`yoke list`/the review queue can be filtered on it. The claim moves from "this cannot happen" to
"you can always tell", which is the claim the audit trail already makes about everything else.

**The new test 3.** *No editing, and no bypass.* A screen may create records and relations
through `commit()`, which means: enters as `draft`, validated against the ontology, provenance
stamped with the real actor and `origin: "web"`, audit row written. A screen may NOT modify an
existing record's attributes, may not write a record in any state but `draft`, and may not reach
the store except through a core function. Attribute correction stays what it always was — a new
version through the gate, from the adapter that owns the source.

**Still forbidden**, and these are the ones that keep this from becoming an editor: editing an
existing record's attributes from a screen; bulk import; any write that skips `commit()`; any
write that lands as anything but `draft`.

**CLI parity is unchanged and is the binding constraint.** Every button added under this
amendment maps to a command that already exists — `yoke add`, `yoke link`, `yoke verify`,
`yoke deprecate`, `yoke backfill`, `yoke rename-type`. A button with no command is still a bug,
and `yoke link` was written first for exactly that reason.

## Amendment (2026-07-31, second): browse may have a query box

`browse` gains a text query. The reasoning, and what replaces the ban:

**What the ban was actually protecting.** yoke's value is *injection* — an agent is handed the
relevant subset without anyone looking anything up. A good human search box competes with that:
people search instead of capturing, the review queue stops being the way knowledge becomes
trusted, and the store decays into a wiki that happens to have types. That risk is real and the
ban was a reasonable way to hold it off while the injection path was being built.

**Why it does not require forbidding the box.** Two things, and the second is the decisive one.

First, `browse` already lists every record in the namespace — draft, stale and deprecated
included, each with its status rendered — with type and status filters and keyset paging. A person
can already read unverified knowledge from a screen. A query box changes how long that takes, not
whether it is permitted.

Second, **the tripwire as written was already tripped by screens this document blesses.** It said
a query box that "returns knowledge `yoke_inject` would have withheld" has become the search UI
and must be removed. `browse` returns exactly that, and `GET /api/entities` writes no audit row.
Read literally, the rule condemned `browse`, not a search box. A rule the shipped code violates
is not protecting anything — it is just unenforced, and unenforced rules are how a codebase learns
that its documents can be ignored.

**What replaces it.** Three guarantees, each of which is checkable rather than aspirational:

1. **Records, not answers.** Search returns the same row shape `browse` returns — type, summary,
   effective status, actor, citation — through the same `KnowledgeTable`. A draft hit reads as a
   draft. No prose, no "best match" framing, no result the reader cannot trace to a stored row.
2. **The port's retrieval, not ours.** The box calls the `search(TextQuery)` the storage port has
   had since v1 and that `inject` itself falls back to. No re-ranking in the web tier and no
   scoring invented for the screen — test 2 ("no relevance ranking outside the injection ranker")
   survives intact, because there is no second ranker.
3. **Bounded, and it says so.** `search` takes a `limit` and has no cursor: it returns a top-N,
   never a walk of the corpus. Over the cap the screen says how many it left off, the way the
   graph and briefing screens already do. The way to get everything is still `inject`, or the CLI.

**And the audit claim gets made true.** SPEC's rule — "any route that returns knowledge attributes
writes an audit row" — was already false in one place: `GET /api/entity/:id` returns full
attributes and wrote nothing, and so does `yoke get`. Both are fixed in the same change as this
amendment, under a new `read` action, and the query box writes a `search` row. `search` is its own
action rather than folded into `read` because a query records something an enumeration does not:
what someone was looking for. Distinguishing "who listed the namespace" from "who asked for X"
from "what an agent was told" is the whole point of having action names.

**The cost, stated.** The trail now grows when people read, not only when they govern. On a local
single-user database that is a row per record opened, which is the intended trade: `yoke audit`
answers "what did I look at" as well as "what did I promote". If that noise ever swamps the
governance rows, the fix is a filter on the audit screen — which already exists — not a quieter
rule.

**Still forbidden.** A conversational surface; any model call from the web tier; synthesized prose;
a second ranker; presenting results as an answer; and search over anything but stored records.

**CLI parity is unchanged and binding.** `yoke search` already exists and predates this box; it
gains `--status` so the two surfaces can express the same query, and the `search` audit row so the
trail does not depend on which interface was used.
