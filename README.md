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

MIT · feature-complete through v6.1 · [visual overview](https://claude.ai/code/artifact/5bdddc2e-a8f7-48ba-93b7-261b8b7a26b7)

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
   (`yoke verify`), and there is no MCP tool that does it. By default only
   `verified` knowledge reaches your AI's context; an agent can ask for drafts
   explicitly (`includeDraft`) and they arrive labelled `[draft]`. One documented
   exception: `connect rdb` maps an existing database that is already the org's
   system of record, so mapped rows land verified — see docs/BACKENDS.md.
3. **Nothing is silently overwritten.** Storage is append-only: an edit is a new
   version, and there is no delete at all — retirement is a status (`deprecated`). You can always reconstruct what the
   system believed at any point in time, and every injected item carries a
   citation — `[type:id@vN] author (confirmed by promoter), occurred_at` — so
   every claim is auditable and names both who wrote it and who vouched for it.
   The one mutation history cannot record is `rename-type`, which rewrites the
   type on existing version rows; it leaves an audit row saying so.
4. **Contradictions are surfaced, never auto-resolved.** When new knowledge
   conflicts with what's already verified, yoke keeps both and links them with
   a `conflicts_with` edge for a human to settle, and injection serves both
   sides marked as disputed. A disagreement is itself knowledge; deciding the
   winner is not the database's job. Automatic *detection* compares embeddings,
   so it needs an embedding provider configured (below) — without one, records
   you link yourself are still surfaced, but nothing is detected for you.
5. **Knowledge expires.** Verified isn't forever — entries lose freshness past
   their type's TTL and are demoted to `stale` at read time, out of the
   injection path until someone re-confirms them. Stale truths are the
   politest form of misinformation, and yoke treats them that way.

And it's measured, not asserted: the injection-quality eval reports **0%
contamination** (no draft record reaching an injection — drafts are what it plants) and
**0% missed contradictions** on its planted pairs. What those numbers cover, and what
they do not, is in [Measuring quality](#measuring-quality).

Runs local and embedded — better-sqlite3 + FTS5 + sqlite-vec, no server required.

## Less context, not more

Memory layers retrieve passages and paste them in. yoke injects **records** — a
decision with its rationale, a preference, a fact — already distilled, so every
token you spend is a claim rather than the prose around one.

Measured against two retrieval baselines in one harness — same corpus, same
questions, same answering model, 42 questions over two people:

| | injected context | accuracy |
|---|---|---|
| no memory | 0 | 59.5% |
| **yoke** | **1.2k tokens** | 73.8% |
| keyword chunks | 5.1k tokens | 61.9% |
| dense + sparse hybrid, top-50 chunks | 22.8k tokens | 71.4% |

**5.2× the answers per token of chunk retrieval, 20× that of the hybrid
retriever** — and higher accuracy than both, on a fifth to a twentieth of the
context. The hybrid buys its 71.4% with a 22.8k-token injection, most of a
small model's context window spent on one question.

Translated to the benchmark's official evaluation conditions, yoke lands at
~87% — the range of the top published systems, on a twentieth of the injected
context.

Every record also arrives with its citation, which a pasted passage cannot do.

## At a glance

| | |
|---|---|
| **One-line summary** | A database optimized for knowledge: structure it as an ontology, then inject only the verified subset relevant to the current context into your AI — with citations. |
| **Front adapters** | An **MCP server** (`inject` · `commit` · `record_decision` · `overview` · `persona` · `use_scope`) and a **thin CLI**. Every AI tool is just an MCP client — no per-tool adapter. |
| **Storage backends** | `sqlite` (default, FTS5 + sqlite-vec) · `postgres` (native scored FTS + pgvector, no extra dependency) · `opensearch` (native BM25 + k-NN, no extra dependency) — point either remote one at the server your company already runs · `sharded` (federation by tenant). All four pass one conformance suite. |
| **Capture connectors** | `github-pr` (review comments), `slack` (channels + threads), `notes` (local transcripts), `raw` (unstructured material — transcripts, docs — model-extracted) — external sources → draft knowledge, dated from the source. `rdb` (Postgres/MySQL read-mapping) maps a database that is already the system of record, so its rows land verified. |
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
  --attr rejected_alternatives="in-process cache" \
  --attr rejected_alternatives="memcached"
```

`rejected_alternatives` is a list, and a repeated `--attr` is how the CLI builds one — a single
occurrence is a string, which the gate rejects for a list-typed attribute.

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
- `yoke_overview` — the corpus at a glance: counts by type, the most-connected records, who authored what
- `yoke_use_scope` — pin the current collaboration so the whole session shares one working context

## Embeddings

**No model ships with yoke, and none will.** One provider setting — the API **root** of an
OpenAI-compatible embeddings service — which is why the same three lines reach OpenAI, Azure, Ollama,
vLLM, TEI and LiteLLM. yoke appends `/embeddings` itself, so a URL that already ends in it requests
`/v1/embeddings/embeddings` and the embedder breaks silently. Bundling an ONNX runtime would add 258MB of platform binaries and a second cross-platform
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
export YOKE_EMBED_URL=https://api.openai.com/v1     # the API root — no trailing /embeddings
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
| Search / injection | yes | keyword only — a question-shaped query drops from recall@10 82.4% to 52.0% on the demo gold set |

Coverage is repairable at any time — the vector is a derived index, not knowledge, so this writes no
new version and changes no citation:

```bash
yoke backfill --embeddings                 # index every record with the current model
yoke backfill --embeddings --rebuild       # after CHANGING model (dimension differs)
```

A database written before the index key became prose needs one `yoke backfill --embeddings --rebuild`
to re-key both halves of its index. Until it runs, that store searches on the old key — nothing
breaks, results just rank worse.

A database holds one vector space. Switching models without `--rebuild` fails loudly with the
dimension it found and the command above — a mixed space would return confidently wrong neighbours
instead.

## Using a server your company already runs

Point yoke at a Postgres or an OpenSearch you already operate. The knowledge goes there; **this client's audit
trail and API tokens stay in a local sqlite** — yoke's own bookkeeping does not belong in someone else's
database, and asking for a place to put it would get a no.

```bash
# Postgres — the database most orgs already have. pgvector gives `similar` when present.
export YOKE_POSTGRES_URL=postgres://user:pass@localhost:5432/db
export YOKE_POSTGRES_SCHEMA=team_a               # optional: two yoke DBs in one database

# — or OpenSearch (setting both is an error, not a precedence order)
export YOKE_OPENSEARCH_URL=http://localhost:9200
export YOKE_OPENSEARCH_USER=admin YOKE_OPENSEARCH_PASSWORD=…   # a secured cluster only
export YOKE_OPENSEARCH_PREFIX=team_a_            # optional: two yoke DBs in one cluster

yoke init                                        # creates the schema/indices, seeds the ontology
```

Or put the same lines in a **`.env`** in the working directory — `cp .env.example .env` and uncomment.
Node's own parser reads it, so there is no dependency and no format of ours, and an actual environment
variable still wins over the file, which keeps a CI secret ahead of anything left on disk. `.env` is
gitignored; `.env.example` is committed and lists every `YOKE_*` variable yoke itself reads.

`--db` still names the local sqlite. Everything else is unchanged — `add`, `review`, `verify`,
`inject`, `yoke ui`, MCP. Both backends rank search **natively and scored** (Postgres `ts_rank`,
OpenSearch BM25) and both serve `similar` from the engine (pgvector / k-NN), so retrieval needs no
second service. Neither adds a dependency: `pg` was already in the tree for the RDB connector, and
the OpenSearch adapter is plain REST.

What lives where, and why: `docs/BACKENDS.md`. The short version is that `YokeStore`'s extension
surface is synchronous (better-sqlite3 shaped it), so a networked backend is *composed* with a local
sqlite rather than swapped in — and an adapter that cannot satisfy those synchronous signatures is not
selectable at all.

```bash
docker run -d --name yoke-opensearch -p 9200:9200 \
  -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
  -e DISABLE_INSTALL_DEMO_CONFIG=true -e "OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m" \
  opensearchproject/opensearch:2
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
force-directed graph explorer, and the audit log. One static bundle, one port. Under
`yoke serve` the same process also answers `POST /mcp`, so a team deployment needs
nothing extra; `yoke ui` serves the workbench only.

Servers bind loopback by default. `yoke ui` has no authentication, so widening it is an
explicit `--host` and it warns that anyone reachable can read, create, retire and rename
this database's knowledge; issuing credentials is refused to non-loopback callers there.
`yoke serve` refuses a non-loopback bind without `--auth` outright, since it can
authenticate and therefore has no reason not to.

## CLI

```
yoke init | add | get | search | list | link | verify | deprecate
yoke review [--stale]                         # drafts awaiting review / verified past their TTL
yoke inject <query> [--include-draft] [--limit n] [--scope <id>] [--depth n] [--as-of ts]
yoke overview | graph [--limit n]             # the corpus at a glance / as edges
yoke conflicts | ontology <list|add-type> | rename-type <from> <to>
yoke persona <person-id> [--out dir] | persona --check <SKILL.md>
yoke history <id> | audit [--since ts] [--until ts] [--limit n] [--shape]
yoke connect github-pr|slack|notes|raw|rdb ...
yoke mcp | ui | serve [--auth] [--host addr] | token <create|list|revoke>
yoke backup <dest.db> [--force] | restore <src.db> [--force]
yoke export --until <ts> --out <new.db>       # --shards <file> federates backends
yoke backfill [--embeddings [--rebuild]]      # repair authorship edges / the vector index
yoke backfill --occurred-at [--dry-run]       # restore event times a pre-fix verify overwrote
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

yoke measures three different things, and they answer different questions.

**Injection quality** (`npm run eval`) — does the filter hold, and is the detection
wired up:

| Metric | Definition | Target | Measured |
|---|---|---|---|
| Contamination rate | Share of draft entries among inject results | 0% | **0.0%** (only the 20 verified of 40 candidates were injected) |
| Missed-contradiction rate | Share of opposing-conclusion decision pairs with no conflicts_with edge | 0% | **0.0%** (5/5 detected) |

Read those two numbers for what they cover: a 50-record synthetic corpus and a stub
embedder whose vectors are built from the planted topic word, so the contradiction
figure measures that stage 4 runs and files the edge — not that a real embedding model
would notice. Precision is not measured on either axis.

**Persona quality** (`npm run eval:persona`) — does a persona return that person's
verified judgment and nothing else. Five planted failure modes (a colleague's records on
the same topics, association without authorship, sources someone else wrote, the
person's own drafts, their own aged records): impersonation, draft-leak and stale-leak
rates **0%**, recall **100%** whole and under a topic query.

**Retrieval quality** (`npm run eval:retrieval -- <db>`) — does the right record come
back, over `eval/gold-set.json` on a loaded corpus. This is the one that measures search
against real text. On the demo corpus with `bge-m3`, 66 queries at k=10: recall@10
**85.4%**, nDCG **75.7%**, accuracy@1 **65.2%** — 89 of the 109 relevant records found
(measured 2026-08-17). How the query is phrased is what moves that number: a sentence,
which is what an agent sends, scores recall@10 82.4%; one to three terms scores 100%.
The report names the queries that came back with nothing relevant rather than only the
totals.

## Docs

| Doc | What's in it |
|---|---|
| [VISION](docs/VISION.md) | Why yoke exists, the version scope, persona & shared context |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | The ports-and-adapters boundary |
| [KNOWLEDGE-POLICY](docs/KNOWLEDGE-POLICY.md) | The gate, lifecycle, and injection-filter rules |
| [SPEC](docs/SPEC.md) | The implementation contract — schema, port, gate, MCP tools, CLI |
| [WEB-UI](docs/WEB-UI.md) | The governance workbench — the twelve screens and the line we don't cross |
| [ROADMAP](docs/ROADMAP.md) | v0.1 → v6.1 built, in order, each section a record |
| [BACKENDS](docs/BACKENDS.md) | Adapter extension + RDB read-mapping (with live-verification notes) |
| [ENTERPRISE](docs/ENTERPRISE.md) | Multi-tenancy, auth, RBAC, replication, sharding |
| [MARKET](docs/MARKET.md) | Competitive landscape and positioning |

## License

MIT
