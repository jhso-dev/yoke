<div align="center">
<pre>
██╗   ██╗ ██████╗ ██╗  ██╗███████╗
╚██╗ ██╔╝██╔═══██╗██║ ██╔╝██╔════╝
 ╚████╔╝ ██║   ██║█████╔╝ █████╗
  ╚██╔╝  ██║   ██║██╔═██╗ ██╔══╝
   ██║   ╚██████╔╝██║  ██╗███████╗
   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝
</pre>

**Knowledge your AI can trust.**

ontology-based knowledge database · governed context injection for AI agents · MCP-native

MIT · feature-complete through v5.0 · [visual overview](https://claude.ai/code/artifact/5bdddc2e-a8f7-48ba-93b7-261b8b7a26b7)

**English** | [한국어](README.ko.md)

</div>

---

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

## At a glance

| | |
|---|---|
| **One-line summary** | A database optimized for knowledge: structure it as an ontology, then inject only the verified subset relevant to the current context into your AI — with citations. |
| **Front adapters** | An **MCP server** (`inject` · `commit` · `record_decision` · `persona` · `use_scope`) and a **thin CLI**. Every AI tool is just an MCP client — no per-tool adapter. |
| **Storage backends** | `sqlite` (default, FTS5 + sqlite-vec) · `neo4j` (native full-text + vectors + traversal; point it at the server your company already runs) · `kuzu` (embedded graph) · `qdrant` (vector search) · `sharded` (multi-backend federation by tenant). All pass one conformance suite. |
| **Capture connectors** | `github-pr` (review comments), `slack` (channels + threads), `notes` (local transcripts), `rdb` (Postgres/MySQL read-mapping) — external sources → draft knowledge. |
| **Anchored injection** | One mechanism, two entry points: anchor on a `collaboration` for the team's shared working context, or on a `person` for a persona. |
| **Persona** | "How would a teammate decide?" → their recorded, verified judgments, cited and generated live. Citation, not impersonation. |
| **Shared working context** | Pin a `collaboration` and a team shares one context; scope prioritizes without hiding org-wide knowledge. |
| **Enterprise** | Namespaced multi-tenancy · OIDC/SSO + API tokens · RBAC (the `verify` permission is the governance permission) · read replicas · online backup + point-in-time export. |
| **License** | MIT |

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
      "command": "yoke",
      "args": ["mcp", "--db", "./yoke.db"]
    }
  }
}
```

Tools exposed:

- `yoke_inject` — query a context → inject verified knowledge, with citations
- `yoke_commit` — stage knowledge (enters as `draft`)
- `yoke_record_decision` — decision shortcut (conclusion + rationale + rejected alternatives)
- `yoke_persona` — person-scoped injection ("how would a teammate decide?")
- `yoke_use_scope` — pin the current collaboration so the whole session shares one working context

## Embeddings

**No model ships with yoke, and none will.** One provider setting — an OpenAI-compatible
`/embeddings` endpoint — which is why the same three lines reach OpenAI, Azure, Ollama, vLLM, TEI and
LiteLLM. Bundling an ONNX runtime would add 258MB of platform binaries and a second cross-platform
prebuild trap to a CLI people install globally; every practice we surveyed keeps the model out of the
application process.

Free, local, and keyless via [Ollama](https://ollama.com):

```bash
ollama pull bge-m3
export YOKE_EMBED_URL=http://localhost:11434/v1
export YOKE_EMBED_MODEL=bge-m3                      # no key needed
```

`bge-m3` is the recommended default: 100+ languages in one model, 8192-token context, 1024
dimensions, MIT. **If your knowledge is not mostly English, do not use `nomic-embed-text`** — it is
English-centric, so semantic matching on other languages quietly degrades to roughly what keyword
search already gave you, which looks like a working setup and is not.

A hosted provider instead:

```bash
export YOKE_EMBED_URL=https://api.openai.com/v1
export YOKE_EMBED_MODEL=text-embedding-3-large
export YOKE_EMBED_KEY=sk-...
```

**Set it in the shell, not only in `.mcp.json`.** MCP server env applies to that process alone, so a
`.mcp.json`-only setup leaves `yoke add`, `yoke ui` and every connector writing records with no
vector — measured at 1 of 3 entities in this repo's own database before it was fixed.

### What embeddings do, and what happens without them

| | with a provider | without |
|---|---|---|
| Knowledge is stored | yes | **yes** — a provider being down never rejects a record |
| Duplicate candidates on commit | yes | **no, and `yoke add` says so** — there is no keyword fallback for this, because treating every FTS hit as a duplicate is mostly false positives |
| `conflicts_with` auto-detection | yes | no |
| Keyword search / injection | yes | yes, unaffected |

Coverage is repairable at any time — the vector is a derived index, not knowledge, so this writes no
new version and changes no citation:

```bash
yoke backfill --embeddings                 # index every record with the current model
yoke backfill --embeddings --rebuild       # after CHANGING model (dimension differs)
```

A database holds one vector space. Switching models without `--rebuild` fails loudly with the
dimension it found and the command above — a mixed space would return confidently wrong neighbours
instead.

## Using your company's Neo4j

Point yoke at a Neo4j you already run. The knowledge goes there; **this client's audit trail and API
tokens stay in a local sqlite** — yoke's own bookkeeping does not belong in someone else's database,
and asking for a place to put it would get a no.

```bash
export YOKE_NEO4J_URL=bolt://localhost:7687      # or neo4j+s://… for Aura
export YOKE_NEO4J_USER=neo4j
export YOKE_NEO4J_PASSWORD=…
export YOKE_NEO4J_DATABASE=neo4j                 # optional

yoke init                                        # creates constraints + indexes, seeds the ontology
```

`--db` still names the local sqlite. Everything else is unchanged — `add`, `review`, `verify`,
`inject`, `yoke ui`, MCP. Neo4j is the only backend with **native full-text search, native vectors and
native traversal in one engine**, so search is ranked by the index itself rather than app-level, and
`similar` needs no second service.

What lives where, and why: `docs/BACKENDS.md`. The short version is that `YokeStore`'s extension
surface is synchronous (better-sqlite3 shaped it), so a networked backend is *composed* with a local
sqlite rather than swapped in — which is also why `kuzu` and `qdrant` were never selectable from the
CLI despite passing conformance.

```bash
docker run -d --rm --name yoke-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/testtest neo4j:5
```

## Web UI

A governance workbench in the browser — the human side of the same core functions the
CLI exposes. Not a place to ask questions of your knowledge (that's your AI's job, over
MCP): every screen shows **records**, typed and versioned and cited.

```bash
yoke ui                      # http://127.0.0.1:4800 — local, single-user, ungated
yoke serve --auth --host 0.0.0.0   # a team; log in with a token from `yoke token create`
```

Screens: the review queue, conflicts, the ontology browser, persona preview, entity
detail, injection preview ("what would my agent actually receive for this query?"), a
force-directed graph explorer, and the audit log. One static bundle, one port — the same
process answers `POST /mcp`, so there is nothing extra to deploy.

Servers bind loopback by default. `yoke ui` has no authentication, so widening it is an
explicit `--host` and says so; `yoke serve` refuses a non-loopback bind without `--auth`.

## CLI

```
yoke init | add | get | search | review | verify | deprecate
yoke inject <query> [--include-draft] [--scope <id>]
yoke conflicts | ontology <list|add-type> | persona <person-id>
yoke history <id> | audit [--since ts] [--limit n]
yoke connect github-pr|slack|notes|rdb ...
yoke mcp | ui | serve [--auth] [--host addr] | token <create|list|revoke>
yoke backup | restore | export [--until ts]   # --shards <file> federates backends
yoke backfill                                 # derive missing authorship edges (upgrade path)
```

Common options: `--db` (> `YOKE_DB` env > `./yoke.db`), `--actor`
(> `YOKE_ACTOR` env > `yoke:system`), and `--json` (machine-readable output).

## Shared working context

A team builds one knowledge space together, in real time. When the user says
"this is PAY-42 work", the agent declares it once with `yoke_use_scope`, and the
whole session defaults to that `collaboration` — injections lead with its knowledge,
and anything recorded links to it automatically. A decision one person records
(and a human verifies) is in every other session's context the next time they ask.

Scope **prioritizes, it doesn't imprison**: a pinned collaboration leads, but
org-wide facts and personas still flow in on a query. And the context outlives
the work — when the collaboration wraps, its knowledge stays in the graph as org
memory rather than vanishing into a closed ticket.

A persona is the same mechanism anchored on a person instead of a collaboration —
authorship is a graph edge, so "what does this person know" and "what do we know
about this work" are one walk with two names. The one difference is deliberate: a
persona is strict, because presenting knowledge someone didn't author as their
judgment would be impersonation.

## Measuring quality

Instead of a recall benchmark, yoke measures **injection quality** (`npm run eval`):

| Metric | Definition | Target | Measured |
|---|---|---|---|
| Contamination rate | Share of draft entries among inject results | 0% | **0.0%** (only the 20 verified of 40 candidates were injected) |
| Missed-contradiction rate | Share of opposing-conclusion decision pairs with no conflicts_with edge | 0% | **0.0%** (5/5 detected) |

## Docs

| Doc | What's in it |
|---|---|
| [VISION](docs/VISION.md) | Why yoke exists, the version scope, persona & shared context |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | The ports-and-adapters boundary |
| [KNOWLEDGE-POLICY](docs/KNOWLEDGE-POLICY.md) | The gate, lifecycle, and injection-filter rules |
| [SPEC](docs/SPEC.md) | The implementation contract — schema, port, gate, MCP tools, CLI |
| [WEB-UI](docs/WEB-UI.md) | The governance workbench — the ten screens and the line we don't cross |
| [ROADMAP](docs/ROADMAP.md) | v0.1 → v5.0 built; the browser pass is done and recorded (it found six defects) |
| [BACKENDS](docs/BACKENDS.md) | Adapter extension + RDB read-mapping (with live-verification notes) |
| [ENTERPRISE](docs/ENTERPRISE.md) | Multi-tenancy, auth, RBAC, replication, sharding |
| [MARKET](docs/MARKET.md) | Competitive landscape and positioning |

## License

MIT
