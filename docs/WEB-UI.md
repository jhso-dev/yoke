# yoke — Web UI (v2.5 design)

The web UI is a **governance workbench**. It is not a search or chat UI (that's the
job of the AI tools, and yoke feeds those tools via MCP). Detailed when work starts
(v2.5).

## Screens (these four, and no more)

1. **Review queue** — the draft list, with source and duplicate candidates shown,
   and bulk verify/reject. Reason for being: drive promotion friction close to zero
   (addressing MARKET risk 1). The core screen.
2. **Conflicts view** — conflicts_with pairs compared side by side; deprecate one
   side or keep them coexisting.
3. **Ontology browser** — visualize types and relations, with migration history.
4. **Persona preview** — pick a person → review the knowledge that would be injected
   → export the skill.

## Design decisions

- Server: embedded in the CLI (`yoke ui` → a local HTTP server). In the v3 server
  mode, the same UI is served remotely — not a separate artifact.
- Stack: deferred to the prevailing stack at start time. Only two conditions are
  fixed — a single static bundle (embedded distribution), and the API is only the
  HTTP exposure of core functions (no UI-only business logic — every action must be
  possible from the CLI too).
- Audit surfacing: across every screen, knowledge is always shown with its source
  and version.

## What we don't do

- A chat/search interface, a knowledge-authoring editor (authoring is the capture
  path's job), or dashboard-style statistics (CLI output is enough for the eval
  report).
