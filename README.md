# yoke

**Knowledge your AI can trust.**

An AI agent with memory will repeat whatever it heard. An AI agent on yoke
speaks only knowledge that carries a source, survived review, and is still
current — and it cites its sources. Memory layers automate *what your AI
remembers*; yoke governs *what your AI is allowed to believe*.

## Why you can trust it

Trust isn't a promise here — it's five mechanisms, each enforced in code:

1. **Nothing enters without a source.** Every write passes through a single
   commit gate that rejects knowledge with no provenance (who said it, where,
   when). Knowledge without a source is just a rumor, and rumors don't get in.
2. **Nothing is believed until a human verifies it.** New knowledge lands as a
   `draft`, quarantined from injection. AI agents can *record* knowledge over
   MCP, but they cannot promote it — verification is deliberately a human act
   (`yoke verify`). Only `verified` knowledge ever reaches your AI's context.
3. **Nothing is silently overwritten.** Storage is append-only: an edit is a new
   version, a deletion is a tombstone. You can always reconstruct what the
   system believed at any point in time, and every injected item carries a
   citation — `[type:id@vN] actor, occurred_at` — so every claim is auditable.
4. **Contradictions are surfaced, never auto-resolved.** When new knowledge
   conflicts with what's already verified, yoke keeps both and links them with
   a `conflicts_with` edge for a human to settle. A disagreement is itself
   knowledge; deciding the winner is not the database's job.
5. **Knowledge expires.** Verified isn't forever — entries lose freshness past
   their type's TTL and are demoted to `stale` at read time, out of the
   injection path until someone re-confirms them. Stale truths are the
   politest form of misinformation, and yoke treats them that way.

And it's measured, not asserted: the injection-quality eval reports **0%
contamination** and **0% missed contradictions** (see below).

Runs local and embedded — better-sqlite3 + FTS5 + sqlite-vec, no server required.

## 60-second quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/jhso-dev/yoke/main/scripts/install.sh | bash
# clones to ~/.yoke/app, builds, and links the global `yoke` command
# (--skip-link to skip the link, --dir PATH to change the location)

yoke init                                    # create ./yoke.db + seed the ontology
yoke add fact --attr statement="Deployments only happen Tuesday mornings"
yoke review                                  # inspect the draft queue
yoke verify <id>                             # promote it (or: yoke verify --all-drafts)
yoke inject "when do we deploy"              # inject only verified knowledge, with citations
```

Anything added via `add` starts as a `draft`. It won't show up in `inject` until
you promote it with `verify` — that gate is the whole point of the governance
model. Use `yoke verify --all-drafts` to promote in bulk on a cold start.

Prefer to build from source (contributors)? Clone and link directly:

```bash
git clone https://github.com/jhso-dev/yoke && cd yoke
npm install && npm run build && npm link   # provides the global `yoke` command
```

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

Free, local, and keyless via [Ollama](https://ollama.com) (verified live —
duplicate warnings and `conflicts_with` detection both fire):

```bash
ollama pull nomic-embed-text
export YOKE_EMBED_URL=http://localhost:11434/v1
export YOKE_EMBED_MODEL=nomic-embed-text            # no key needed
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
