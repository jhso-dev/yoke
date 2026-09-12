# yoke — Market (surveyed 2026-07)

## One-line positioning

**"Knowledge your AI can trust."**
Competitors sell memory (automatic); yoke sells knowledge (governed). A memory layer automates what the AI remembers; yoke governs what the AI is allowed to believe — and the load-bearing case is the team's **decision flow**: memory products store what one agent saw, while yoke relays what the team settled (and un-settled) into every running session, rejected alternatives attached. The trust claim is backed by mechanism, not marketing: sourced-and-signed entry, freshness decay with a re-confirmation queue, preserved contradictions served as disputed, retirement broadcast to everyone previously handed the record, and an append-only audit trail (see README "Why you can trust it"). The Git analogy (commits/blame/merge conflicts ↔ append-only versions/signed provenance/conflicts_with) remains useful as an explanatory device, but not as the tagline.

## Competitive landscape (five categories)

| Category | Players | Relationship to us |
|---|---|---|
| AI memory layers | **Cognee** (embedded graph+vector, our closest competitor), **Zep/Graphiti** (bitemporal, contradiction invalidation), Mem0, Letta, LangMem | Head-on overlap. But all lean "automatic," with no governance |
| MCP memory servers | Basic Memory, Knowledge Graph Memory (the official reference), RAG Memory | Personal-grade. Also our early distribution channel |
| Ontology / KG databases | TypeDB, Stardog (RDB virtual-graph federation), Graphwise/Ontotext, Fluree | Governed, but heavy and expensive — the SPARQL world |
| GraphRAG frameworks | MS GraphRAG, LlamaIndex, txtai, RAGFlow, R2R | A pipeline, not a system of record |
| Enterprise search SaaS | Glean, Onyx (open source), GoSearch, Guru, Dust | Document search, not structured knowledge management |

### Update (2026-08): Spotify XIRP + Portal

Spotify's Portal Workspaces bundle catalog entities, docs, ownership, and past session transcripts,
and expose them to any agent over MCP — "build context once, use it across agents." A major
platform-engineering vendor arriving at the same shape (a shared working-context anchor, delivered
MCP-only) corroborates two of our bets: the `collaboration` briefing and invariant 3. The split that
remains is the trust model — Portal shares session transcripts, yoke injects governed records only
(signed, fresh, disputes marked, retirements withheld and broadcast).
Watch item: if Portal adds record-level governance it enters our quadrant from above.

## An honest assessment

Combine Cognee and Graphiti and most of our technical design already exists in some form (surveyed 2026-07, by reading their docs — not a measured overlap). We can't differentiate on technology. **We differentiate on the trust model.**

## Strategy

1. **Split the category**: "automatic memory" vs. "governed knowledge" — a record-level lifecycle (signed entry, freshness lease, retirement with a broadcast reason), disputes surfaced instead of auto-resolved, an auditable history. Capture is as automatic as anyone's; what competitors don't have is everything that holds a record accountable afterwards — and they can't add it without admitting their memories need governing. A structural moat.
2. **The empty quadrant**: enterprise governance × local/embedded lightweight. Start with `npx yoke` and grow into the organization's knowledge system of record.
3. **Traditional-DB read-mapping is the enterprise wedge**: "read your existing RDB as an ontology and inject it into AI, with no migration" — no one serves this segment in a lightweight, MCP-native way.
4. **Adoption path**: individual developer (MCP server) → team (governance kicks in) → organization. Not top-down sales.
5. **persona is the killer use case**: person-scoped continuity of judgment has no competitor within the survey's scope.
6. **Prove it by measurement**: instead of a recall benchmark (Zep reports DMR 94.8%), define our own eval for injection quality (contaminated-knowledge injection rate, undetected-contradiction rate).

**Don't do**: go head-to-head on conversational auto-extraction (Mem0), RAG pipelines (LlamaIndex), or document search (Glean).

## Risks

- If the governance friction is expensive, we look like "a clunkier Mem0" → entry has no queue at all; keep the one human surface (the re-confirmation queue) cheap: batch verify, most-consumed first.
- If the market pain of "the AI answered with wrong internal knowledge" arrives late, the differentiation lands late → v1 enters as an MCP server that is immediately useful to an individual.

## Sources

- https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- https://www.cognee.ai/blog/guides/best-ai-memory-layers-for-ai-agents-in-2026-comparison
- https://arxiv.org/abs/2501.13956 (Zep paper)
- https://github.com/getzep/graphiti
- https://mcp.directory/blog/claude-code-memory-mcp-servers-2026
- https://flur.ee/blog/enterprise-kg-buyers-guide-2026
- https://www.firecrawl.dev/blog/best-open-source-rag-frameworks
- https://onyx.app/insights/glean-alternatives
- https://backstage.spotify.com/docs/xirp/xirp-and-portal (2026-08)
