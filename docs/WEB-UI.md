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
3. **No new knowledge.** The only writes are lifecycle transitions on records that
   already exist. Nothing here creates or edits an entity's attributes.

**Why the injection preview is not the search UI we still refuse to build.** It renders
the *injection decision*, not a result set: the same filter, the same ranking, the same
citations, and the same audit row as a real `yoke_inject` call — and no answer text. A
search UI would exist to satisfy the human's question; the injection preview exists to
let a human check what the machine is about to be told, and to leave a record that they
looked. If a query box ever returns knowledge `yoke_inject` would have withheld, or
returns it without an audit row, it has become the search UI and must be removed.

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

A ninth screen requires the three tests above to be argued here first.

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
- **A search UI for human reading.** A query box exists only as the injection preview
  defined above. Free-text retrieval that bypasses the injection filter, or presents
  results as an answer rather than as records, is out.
- **A knowledge-authoring editor.** No create form, no attribute editing, no bulk-import
  screen. Capture stays with MCP, the CLI and the connectors, so everything passes the
  gate with real provenance.
- **Dashboard-style statistics.** Counts and charts nobody acts on. The eval report and
  CLI output cover measurement.
- **Server-side rendering, an API framework, or a second deployable.**
- **UI-only business logic.** Unchanged since v2.5: if a screen wants something the CLI
  cannot do, the answer is a core function and a CLI command, not a route.
