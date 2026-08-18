# yoke — Web UI

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
3. **No editing, and no bypass.** A screen may create records and relations through
   `commit()`, which means: enters as `draft`, validated against the ontology, provenance
   stamped with the real actor and `origin: "web"`, audit row written. A screen may NOT
   modify an existing record's attributes, may not write a record in any state but
   `draft`, and may not reach the store except through a core function. Attribute
   correction is a new version through the gate, from the adapter that owns the source.

**Hand-typed knowledge is allowed, and is labelled as such.** The gate — not the adapter
— is what enforces entry: `commit()` validates and stamps provenance whichever front tier
calls it, and every record enters as `draft` needing a human `verify`. So a form is not a
hole; what a form would otherwise cost is traceability, and `provenance.origin = "web"`
(distinct from `cli`, `mcp` and every connector name) pays it. A reviewer can see which
drafts a person typed at a screen, and `yoke list` / the review queue can filter on it.
The claim is "you can always tell", not "this cannot happen" — the same claim the audit
trail makes about everything else.

**Why the injection preview is not a search UI.** It renders the *injection decision*,
not a result set: the same filter, the same ranking, the same citations, and the same
audit row as a real `yoke_inject` call — and no answer text. A search UI would exist to
satisfy the human's question; the injection preview exists to let a human check what the
machine is about to be told, and to leave a record that they looked.

**Why browsing is not searching.** Navigation — entity → its relations → a neighbour, a
graph node → its detail — reaches a record we already decided to store. It makes the
*shape* of the knowledge visible: orphans, clusters, conflict pairs, what a scope anchor
would pull in. Retrieval-for-reading is what we refuse; reachability-for-governing is
the product.

**A query box over stored records is allowed on `browse`**, under three guarantees, each
checkable rather than aspirational:

1. **Records, not answers.** It returns the row shape `browse` already returns — type,
   summary, effective status, actor, citation — through the same `KnowledgeTable`. A draft
   hit reads as a draft. No prose, no "best match" framing, no result the reader cannot
   trace to a stored row.
2. **The port's retrieval, not ours.** It calls the `search(TextQuery)` the storage port
   has had since v1 and that `inject` itself falls back to. No re-ranking in the web tier
   and no scoring invented for the screen — test 2 survives because there is no second
   ranker.
3. **Bounded, and it says so.** `search` takes a `limit` and has no cursor: a top-N, never
   a walk of the corpus. Over the cap the screen says how many it left off, the way the
   graph and briefing screens do. The way to get everything is `inject`, or the CLI.

The box writes a `search` audit row — its own action rather than folded into `read`,
because a query records what someone was looking for and an enumeration does not.
Distinguishing "who listed the namespace" from "who asked for X" from "what an agent was
told" is the whole point of having action names. The cost, stated: the trail grows when
people read, not only when they govern. If that noise ever swamps the governance rows, the
fix is the filter the audit screen already has, not a quieter rule.

## Screens

The governance set:

1. **Review queue** — the draft list and the stale queue beside it, each row with its
   source, and bulk verify/deprecate. The stale queue arrives most-consumed first with the count on
   each row — the number of inject/persona audit rows naming it — so the reviewer meets the records
   agents are still being fed before the ones nothing reads. Reason for being: drive promotion friction close to
   zero (addressing MARKET risk 1). The core screen. Duplicate candidates surface on
   **create** (the gate returns them to the form), not here — the review payload does not
   carry them. There is no `reject`: the lifecycle has no such transition, and the negative
   action is `deprecate`.

   **Constraint, for whenever this screen serves more than one reviewer: it must not show a
   peer's pending approval.** Seeing early approvals makes later reviewers converge on them
   without the group getting more accurate (`docs/RESEARCH.md` §2), and the anonymity that
   prevents it is the whole mechanism of a Delphi (§3). No such state exists yet — verify is
   immediate and per-actor — so this constrains a future design rather than describing a
   present protection.
2. **Conflicts view** — conflicts_with pairs compared side by side; deprecate one side
   or keep them coexisting.
3. **Ontology browser** — types and relations, with the add-type / rename-type / backfill
   controls. No migration-history view: a migration's trace is the `rename_type` audit row
   and the ontology table's version column, both reachable, neither rendered as a timeline.
4. **Persona preview** — pick a person → review the knowledge that would be injected →
   export the skill.

The viewing set — reading what is already stored, never adding to it:

5. **Entity detail** — one entity: attributes, every version, its relations, its
   authorship edge, computed freshness. The record as stored, nothing inferred.
6. **Injection preview** — a query (optionally scope-anchored) → exactly what `inject()`
   would return, with citations and effective status, audit-logged per preview.
7. **Graph explorer** — the entity/relation graph, force-directed, navigable from any
   node, bounded by the port's enumeration page limit and explicit about truncation.
8. **Audit log viewer** — the append-only audit trail, filterable by actor, action and
   time. The screen that makes "who was told what, when" answerable without shell access.
9. **Collaboration** — pick a unit of work → see who is on it, what is attached to it, and
   the briefing an agent receives when it anchors there.

   Passing the three tests:

   1. **Governance purpose.** It makes an injection auditable *before* it happens. A
      collaboration anchor is first-class in core, MCP and the CLI, and without this screen
      there is no way to see what anchoring on one would hand an agent — the id is
      something you would have to already know. The act it supports is "decide whether this
      working context is fit to brief an agent from", the same act the injection preview
      supports for a query.
   2. **No synthesis.** It composes routes that already exist and adds no endpoint. The
      briefing panel is the real `inject()`, so its ranking is the injection ranker and
      nothing else.
   3. **No editing, and no bypass.** Its mutations create relations through commands that
      already exist — `yoke link <person> works_on` (the roster) and `yoke link <record>
      relates_to` (seeding the working context by hand with knowledge that predates it) —
      plus the lifecycle transitions the shared table offers. Nothing edits a record's
      attributes.

   **Why this is not a search UI.** You do not arrive by querying: you pick from the list of
   collaborations that exist, then read what is attached — reachability-for-governing. The
   briefing panel is the injection-preview argument applied to a scope, and carries the same
   `inject_preview` audit row. The seed search queries records to link, not collaborations to
   reach, through the same bounded `/api/search` the browse screen argues for, with the same
   `search` audit row.
10. **Browse** — the whole namespace as rows, with type/status filters, keyset paging, and
    the query box argued above. A `search` audit row per query.
11. **Tokens** — mint/list/revoke API tokens for `serve`. It governs ACCESS to knowledge
    (who can read, who can verify), which is a governance act even though no knowledge
    renders; it composes the three token routes and synthesises nothing; it creates no
    knowledge. Gated on `admin` under `--auth` — the credential axis, distinct from `verify`, so a
    reviewer does not also get the power to mint credentials (see `Action` in serve/rbac.ts); under
    plain `yoke ui` it is as open as the terminal running it (invariant 4, same trust boundary).
12. **Login** — not a screen about knowledge: the credential prompt `serve --auth` needs so
    a browser can present a token or OIDC identity. Exists because 401 has to land
    somewhere ungated.

A further screen requires the three tests to be argued here first.

## Design decisions

- Server: embedded in the CLI (`yoke ui` → a local HTTP server). In server mode the same
  UI is served remotely — not a separate artifact.
- Stack: Next.js with `output: 'export'`, React, `d3-force`, and the shadcn-style primitive
  layer in `web/components/ui/` with its prerequisites (`radix-ui`, Tailwind v4 + PostCSS,
  `lucide-react`, `class-variance-authority`, `tailwind-merge`, `tw-animate-css`) — the
  dependency budget is in PLAN-V2's non-goals. A build step is allowed; a *server* framework
  is not, and `output: 'export'` is what keeps that honest — the build emits static files,
  the existing `node:http` server serves them, and there is no second process, port, or
  deployable. Two conditions bind: **one static bundle** (embedded distribution), and an API
  that is **only the HTTP exposure of core functions** — no UI-only business logic, so every
  action stays possible from the CLI too.
- Locale: two catalogs, `web/lib/i18n/en.ts` and `ko.ts`, English as the source of truth and
  every other locale typed as `typeof en`, so a missing key is a compile error. The rule that
  decides what is translated: **a stored value is never translated; anything said to a person
  is** — type names and ids render verbatim, labels/ledes/empty-states/notices come from the
  catalog. Four guard tests hold it (`untranslated`, `dead-keys`, `button-case`, `default`).
- Audit surfacing: across every screen, knowledge is shown with its source and version. Two
  source guards hold it, because the type system cannot: a required `citation` field
  guarantees every payload CARRIES a source, and nothing about that makes a screen RENDER
  one. `no-raw-ids.test.ts` requires a citation to be rendered readably rather than as a raw
  ULID; `citation-render.test.ts` requires any file that renders a record label or status
  badge to render `<Citation>` or the shared `KnowledgeTable`, or to carry a named exemption
  with its reason.
- Bind address: loopback by default. `yoke ui` cannot authenticate, so widening it is an
  explicit `--host` and says so loudly; `yoke serve` refuses a non-loopback bind without
  `--auth`.

## Parity is a floor on BOTH surfaces

No screen may do what the CLI cannot — and the reverse also binds: **a governance action
must answer the same questions wherever it is invoked.**

This is the governance workbench. Retiring knowledge is not an incidental thing it can do;
it is the act the screen exists to host. A surface that hosts the act while dropping the
answer that makes the act a repair — what now has to change — is the same defect as UI-only
logic arriving from the other side: one surface knows something the other does not, and
which one you used decides what you learn.

It binds the *answer* to a governance write, not the ergonomics of asking. Not every CLI
flag needs a control; `--json`, `--after`, `--shards` are plumbing.

Concretely: `POST /api/deprecate` returns `{ deprecated, downstream }`, and the entity,
review and conflicts screens render it through **one** component (`Downstream`). One
component rather than three copies is what keeps a fourth deprecate button from being added
without it. A banner, not a toast: the point is to open the records. `/api/verify` keeps its
bare-array shape — only retiring gained a second question.

Every button maps to a command that already exists — `yoke add`, `yoke link`, `yoke verify`,
`yoke deprecate`, `yoke backfill`, `yoke rename-type`, `yoke search`. A button with no
command is a bug.

## What we don't do

- **A chat interface.** No conversational surface, no model call from the web tier, ever.
  Asking questions *of* the knowledge is the AI's job, over MCP.
- **Results presented as an answer.** A query box is allowed (see the three guarantees
  above); synthesized prose, a second ranker, and search over anything but stored records
  are not.
- **Editing an existing record's attributes from a screen**, and **bulk import**. Creating
  records and relations is allowed; correcting one is a new version through the gate.
- **Dashboard-style statistics.** Counts and charts nobody acts on. The eval report and
  CLI output cover measurement.
- **Server-side rendering, an API framework, or a second deployable.**
- **UI-only business logic.** If a screen wants something the CLI cannot do, the answer is
  a core function and a CLI command, not a route.
