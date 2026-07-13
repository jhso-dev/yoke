# yoke

**Git for the knowledge your AI consumes.**

Everyone else sells memory (automatic recall). yoke sells knowledge (governance).
A memory layer automates *what your AI remembers*; yoke governs *what your AI is
allowed to believe*.

- **Single write path**: every piece of knowledge passes through the commit gate
  (ontology validation → provenance checks → duplicate/contradiction detection →
  draft staging). There is no side door.
- **Only verified knowledge is injected**: `draft`, `stale`, and `deprecated`
  entries never reach the AI's context. Corrupt signals stay out.
- **Append-only and auditable**: an edit is a new version row, and every injection
  carries a citation (`[type:id@vN] actor, occurred_at`).
- **Local and embedded**: better-sqlite3 + FTS5 + sqlite-vec. No server required.

## 60-second quickstart

```bash
npm install -g yoke      # or: npx yoke <cmd>

yoke init                                    # create ./yoke.db + seed the ontology
yoke add fact --attr statement="Deployments only happen Tuesday mornings"
yoke review                                  # inspect the draft queue
yoke verify <id>                             # promote it (or: yoke verify --all-drafts)
yoke inject "when do we deploy"              # inject only verified knowledge, with citations
```

Anything added via `add` starts as a `draft`. It won't show up in `inject` until
you promote it with `verify` — that gate is the whole point of the governance
model. Use `yoke verify --all-drafts` to promote in bulk on a cold start.

Recording a decision:

```bash
yoke add decision \
  --attr conclusion="Cache with Redis" \
  --attr rationale="P99 latency exceeded our target" \
  --attr rejected_alternatives="in-process cache"
```

## MCP setup

Attach yoke to an agent (Claude Code and friends) as a stdio MCP server. In your
project root `.mcp.json`:

```json
{
  "mcpServers": {
    "yoke": {
      "command": "npx",
      "args": ["yoke", "mcp", "--db", "./yoke.db"]
    }
  }
}
```

Tools exposed: `yoke_inject` (query a context → inject verified knowledge),
`yoke_commit` (stage knowledge), `yoke_record_decision` (decision shortcut), and
`yoke_persona` (person-scoped injection).

Configure the embedding provider (which enables duplicate/contradiction detection)
through environment variables. If unset, yoke falls back to FTS:

```bash
export YOKE_EMBED_URL=https://api.example.com/v1   # OpenAI-compatible /embeddings
export YOKE_EMBED_MODEL=text-embedding-3-small
export YOKE_EMBED_KEY=sk-...
```

## CLI

```
yoke init | add | get | search | review | verify | deprecate
yoke inject <query> [--include-draft]
yoke conflicts | ontology <list|add-type> | persona <person-id>
yoke connect github-pr --repo owner/name
yoke mcp [--db path]
```

Common options: `--db` (> `YOKE_DB` env > `./yoke.db`), `--actor`
(> `YOKE_ACTOR` env > `yoke:system`), and `--json` (machine-readable output).

## Measuring quality

Instead of a recall benchmark, yoke measures **injection quality** (`npm run eval`):

| Metric | Definition | Target | Measured |
|---|---|---|---|
| Contamination rate | Share of draft entries among inject results | 0% | **0.0%** (only the 20 verified of 40 candidates were injected) |
| Missed-contradiction rate | Share of opposing-conclusion decision pairs with no conflicts_with edge | 0% | **0.0%** (5/5 detected) |

## License

MIT
