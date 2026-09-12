# yoke — Roadmap

What shipped, in the order it shipped. Each version ended in a shippable state, and no version's
items were started before the one below it was done.

This is an index, not a record of how each thing was built — git holds that. Where a version
produced a rule or a measurement that still constrains a decision, it lives in the document that
owns the decision: SPEC for contracts, ENTERPRISE for multi-tenancy and auth, BACKENDS for adapters,
WEB-UI for the web tier, KNOWLEDGE-POLICY for the entry and lifecycle rules, RESEARCH for anything
measured.

## v0.1 — core model, SQLite, gate

Entity/relation types and the ontology-as-records model; the storage port and its conformance suite;
the sqlite adapter (append-only version rows, FTS5); commit gate stages 1–2 (ontology and provenance
validation); the base ontology seed; `init` / `add` / `get` / `search`.

## v0.2 — lifecycle, injection

Status transitions and read-time freshness; `inject()` with its verified-only filter; citation-format
output; `review` and bulk `verify`.

## v0.3 — MCP server

The stdio server (`yoke mcp`) and its tools, verified against a real Claude Code session.

## v0.4 — duplicates, contradictions

Embedding config with FTS fallback; sqlite-vec and the port's `similar` capability; gate stages 3–4
(duplicate suggestion, `conflicts_with`); `yoke conflicts`.

## v0.5 — capture connectors

The connector pattern (external source → records through the one gate), the github-pr connector, and
`yoke connect`.

## v0.6 — persona

Person-scoped query over provenance and relations; SKILL.md export; the `yoke_persona` tool.

## v1.0 — quality, packaging

Conformance suite and CI; the injection-quality eval; npm packaging and the README.

## v2.0 — backends, traditional-DB compatibility

The OpenSearch adapter and the RDB read-mapping connector — the enterprise wedge (BACKENDS).

## v2.5 — web UI

The governance workbench: review, conflicts, ontology browser, persona preview (WEB-UI).

## v3.0 — multi-tenancy, auth

Server mode, OIDC and API tokens, RBAC, namespace isolation, per-tenant ontology overlay
(ENTERPRISE).

## v3.5 — distribution, HA

Read replicas, backup/restore and PITR on the append-only history, tenant-boundary sharding.

## v4.0 — shared working context

Entity-scoped injection, the `collaboration` type and `works_on`, capture-side linking, and the
agent-declared scope. The naming rationale is in SPEC's default ontology.

## v5.0 — the web tier

Port-level enumeration; entity detail, injection preview, graph explorer and audit viewer; `serve
--auth` browser login; the Next.js `output: 'export'` rebuild into one static bundle.

## v5.3 — hybrid retrieval, readable long knowledge

The vector half of `inject`, RRF fusion, stored documents that read as one, and the first gold set.

## v5.5 — the read paths stop paying per row

Batch point reads; `verify`/`deprecate` refusing before they write; the demo corpus moved into the
repo so its measurements are reproducible.

## v5.6 — a question stops being an unsatisfiable conjunction

Long queries become a disjunction, with the keyword half of RRF carrying weight 0.1 — measured
(RESEARCH §5, SPEC "search").

## v5.7 — multi-hop

Bounded anchored traversal and global aggregation, with the walk's budget and its ceilings in SPEC.

## v5.8 — a record's basis

`derived_from`; deprecation naming what rests on what is retired; `persona --check`. One hop, not
the transitive closure — measured (RESEARCH §9).

## v5.9 — the supported set, and configuration

Only selectable backends carried; `.env` via `node:process.loadEnvFile`; every command reports the
store it actually opened (SPEC "Configuration precedence").

## v6.0 — postgres replaces neo4j

The postgres adapter, against the database most orgs already run. Why there is no graph-DB adapter
is in BACKENDS.

## v6.1 — the queue orders by consumption

The stale queue orders by what agents are actually fed, and persona quality gets an eval.

## v6.2 — a working context reaches a running session

`inject --since`, `inject --scope --unseen`, and the per-reader delivery ledger. The recall line's
wording is measured and must not be hardened (RESEARCH §9b).

## v6.3 — a retirement's reason rides on the retiring version

## v6.4 — the decision's author is its verifier

## v6.5 — the harness ships as a Claude Code plugin, from this repo

## v6.6 — the credential a non-interactive client can get by itself

`POST /api/login/github` and the plugin's auth hook (SPEC "GitHub exchange").

## v7.0 — born verified: the gate moves from the door to the lease

`Status = verified | stale | deprecated`; `verify` becomes re-confirmation; `review` IS the stale
queue; RBAC collapses to read/write/admin. Why the gate was removed is in KNOWLEDGE-POLICY.

## v7.1 — instrumentation

`audit --pulse`: capture class, delivery interrupts, recall reach, relitigation, briefing share. The
baseline it took is RESEARCH §6.

## v7.2 — briefing order

The `leads` ontology flag, a comparator rung between hop-distance and freshness, so decisions and
terms reach the opening page of a briefing.

## v7.3 — the session-end flush, measured and not shipped

Nothing ships. The measurement that decided it is RESEARCH §10.

## v7.4 — the merge button is the capture moment

Merged PRs become decisions through the one gate, with `connect --scope` so captured knowledge
reaches a briefing rather than only a query. The workflow recipe is in ADOPTION.

## v7.5 — the soak rig

A standing team server, this repo bound to it, and the day-0 reading in RESEARCH §6. Two defects
found by standing it up: a machine that USES yoke steered the suite that tests it (`vitest.setup.ts`),
and capture and delivery pointed at different stores — the open question that leaves is in ADOPTION.

## v7.6 — the self-check

`scripts/self-check.mjs`: five tripwires on terms no assumption enters and no volume improves, each
firing on a worsening against the team's own previous week. It files a finding and stops. Why it
never optimizes the ROI ratio, and its ceiling, are in ADOPTION.

## Version-promotion rule

Don't start a higher version before the lower one is shipped and verified. When market signals
arrive — the first enterprise customer, the second org — the ordering within a version can change.
