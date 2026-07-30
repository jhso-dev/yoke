# yoke — Vision

## The problem

AI agents don't know an organization's or a person's knowledge. That knowledge is scattered across wikis, databases, files, and people's heads, and what reaches the AI is only the fragments someone copy-pastes by hand, every single time.

## What yoke does

**A database optimized for knowledge.** It structures and stores knowledge as an ontology (an entity/relation schema), then selects the subset relevant to the user's current context and injects it into the AI (context injection).

- **Front end**: interfaces AI consumes well — an MCP server and a CLI. From v5.0 there is also a browser tier for humans, but it is a transport over the same core functions, not a third interface with capabilities of its own (see ARCHITECTURE).
- **Back end**: reuse the stores you already have — SQLite, a traditional RDB, a vector DB, a graph DB, files.
- **Compatibility**: plays well with traditional databases. It must be able to read existing data by mapping it onto the yoke ontology.

## v1 scope

**Included**: the core knowledge model (entity/relation/ontology), one SQLite backend, the MCP server, a thin CLI, basic search (keyword + relation traversal), the full knowledge policy (docs/KNOWLEDGE-POLICY.md — the gate, lifecycle, injection filter, duplicate/contradiction detection, freshness, and the promotion CLI), **persona** (person-scoped queries + skill export), and three capture paths (an MCP recording tool, the CLI, and a GitHub PR review connector).

v1 build order: core model → SQLite → knowledge-policy gate → MCP server → capture → persona. persona sits on top of everything before it, so it comes last.

**Excluded from v1 — planned as later roadmap versions (docs/ROADMAP.md)**:

| Item | Version | Design doc |
|---|---|---|
| Vector/graph DB adapters, RDB read-mapping | v2.0 | docs/BACKENDS.md |
| Audit log | v2.0 | docs/ENTERPRISE.md |
| Web UI | v2.5 | docs/WEB-UI.md |
| Multi-tenancy / auth / RBAC | v3.0 | docs/ENTERPRISE.md |
| Distribution / HA | v3.5 | docs/ENTERPRISE.md |

A PR that implements a higher-version item in a lower version will be rejected. But **the design must not foreclose it** — the backward-compatibility constraints to honor are stated at the top of each design doc (e.g. "Constraints to honor from v0.1 onward" in ENTERPRISE.md).

This table is the **v1 exclusion record** and is not extended as new versions are planned — retrofitting a later decision into it would make it look like a v1 plan. docs/ROADMAP.md is the live version list.

## persona — continuity of a person's judgment (included in v1)

The enterprise requirement: "Even when Alex (the frontend lead) is away, work proceeds on Alex's recorded judgment criteria." In yoke this is not a new system but **a query plus packaging**:

- **A persona is a person-anchored query over the verified knowledge and judgment principles sourced from a specific person.** Hard rule 2 (provenance required) means every piece of knowledge is already tied to a person, which is what makes this possible.
- **The same mechanism as the shared working context, anchored differently.** Injection anchors on an entity and walks one relation hop: anchor a `collaboration` and you get the team's working context, anchor a `person` and you get their persona. One mechanism, two named entry points — the names exist because "how would Alex decide?" and "what do we know about this work?" are different questions to ask, not different machinery. The one behavioural difference is deliberate: a collaboration anchor prioritizes without imprisoning (org-wide knowledge still flows in), while a persona is strict, because presenting knowledge someone did not author as their judgment would be impersonation.
- **The primary consumption path is real-time MCP injection** (the `yoke_persona` tool): when a connected AI hits a moment that needs judgment, it calls the tool, and the result is generated from the verified knowledge as of that moment and injected into context — the same flow as ordinary knowledge injection (`yoke_inject`), only scoped to a person. No files to install or sync. The SKILL.md export (`yoke persona --out`) is an offline fallback for environments with no MCP connection.
- **A derivative, not a stored artifact.** Every call is a regeneration, so stale demotions and deprecations take effect immediately. Snapshot or fine-tuning approaches are forbidden because they don't inherit governance.
- **Citation, not impersonation.** The output takes the form "Alex decided X this way, and the rationale was Y [source]." A hallucinated persona is a contaminated injection; being citation-based is what keeps it auditable.
- **Judgment lives in decisions, not documents.** The default ontology includes a `decision` entity type (conclusion, rationale, rejected alternatives). Without this type, the data a persona stands on never accumulates.

The bottleneck for persona is not the query but **capture**. The three v1 capture paths:

1. **MCP recording tool** — an AI agent loads a decision it made mid-task into yoke via `record_decision` (the MCP server is already in v1, so this is just one more tool).
2. **CLI** — a person records directly.
3. **One external-source connector** — the first target is GitHub PR review comments (in a development org, decision density is highest there and the API is simple). Slack and meeting notes follow the same connector pattern, so from the second one onward it's just adapter work.

Per our market survey, no competitor offers person-scoped continuity of judgment — it's the killer use case for the "governed knowledge" positioning, and yoke's winning bet in v1.

## Success criterion (v1)

From Claude Code, put knowledge into yoke over MCP, then confirm in real use that a contextual query in a different session injects exactly that knowledge back.
