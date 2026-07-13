# yoke — Market (surveyed 2026-07)

## One-line positioning

**"Knowledge your AI can trust."**
Competitors sell memory (automatic); yoke sells knowledge (governed). A memory layer automates what the AI remembers; yoke governs what the AI is allowed to believe. The trust claim is backed by mechanism, not marketing: sourced-only entry, human-gated verification, append-only audit trail, preserved contradictions, and freshness decay (see README "Why you can trust it"). The Git analogy (commits/PR review/merge conflicts ↔ append-only versions/verify gate/conflicts_with) remains useful as an explanatory device, but not as the tagline.

## Competitive landscape (five categories)

| Category | Players | Relationship to us |
|---|---|---|
| AI memory layers | **Cognee** (embedded graph+vector, our closest competitor), **Zep/Graphiti** (bitemporal, contradiction invalidation), Mem0, Letta, LangMem | Head-on overlap. But all lean "automatic," with no governance |
| MCP memory servers | Basic Memory, Knowledge Graph Memory (the official reference), RAG Memory | Personal-grade. Also our early distribution channel |
| Ontology / KG databases | TypeDB, Stardog (RDB virtual-graph federation), Graphwise/Ontotext, Fluree | Governed, but heavy and expensive — the SPARQL world |
| GraphRAG frameworks | MS GraphRAG, LlamaIndex, txtai, RAGFlow, R2R | A pipeline, not a system of record |
| Enterprise search SaaS | Glean, Onyx (open source), GoSearch, Guru, Dust | Document search, not structured knowledge management |

## An honest assessment

Combine Cognee and Graphiti and roughly 70% of our technical design already exists. We can't differentiate on technology. **We differentiate on the trust model.**

## Strategy

1. **Split the category**: "automatic memory" vs. "governed knowledge" — lifecycle, human-owned promotion, verified-only injection, an auditable history. Competitors can't move this way because "automatic" is their sales point (they'd be contradicting their own pitch). A structural moat.
2. **The empty quadrant**: enterprise governance × local/embedded lightweight. Start with `npx yoke` and grow into the organization's knowledge system of record.
3. **Traditional-DB read-mapping is the enterprise wedge**: "read your existing RDB as an ontology and inject it into AI, with no migration" — no one serves this segment in a lightweight, MCP-native way.
4. **Adoption path**: individual developer (MCP server) → team (governance kicks in) → organization. Not top-down sales.
5. **persona is the killer use case**: person-scoped continuity of judgment has no competitor within the survey's scope.
6. **Prove it by measurement**: instead of a recall benchmark (Zep DMR 94.8%), define our own eval for injection quality (contaminated-knowledge injection rate, undetected-contradiction rate).

**Don't do**: go head-to-head on conversational auto-extraction (Mem0), RAG pipelines (LlamaIndex), or document search (Glean).

## Risks

- If the governance friction is expensive, we look like "a clunkier Mem0" → make promotion extremely cheap (batch verify).
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
