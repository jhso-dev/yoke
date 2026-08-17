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
4. **Contradictions are surfaced, never auto-resolved.** When knowledge is
   linked as conflicting, yoke keeps both sides and injection serves them marked
   as disputed, for a human to settle. A disagreement is itself knowledge;
   deciding the winner is not the database's job. Automatic *detection* is the
   weak half and is measured as such: it only inspects records the duplicate
   detector already raised, so on real embeddings it found 1 of 5 planted
   contradictions and linked 5 of 5 compatible refinements — see
   [Measuring quality](#measuring-quality). Treat the edges you file yourself as
   the mechanism, and detection as a hint.
5. **Knowledge expires.** Verified isn't forever — entries lose freshness past
   their type's TTL and are demoted to `stale` at read time, out of the
   injection path until someone re-confirms them. Stale truths are the
   politest form of misinformation, and yoke treats them that way.

And it's measured, not asserted — including where it comes out badly. The
injection-quality eval reports **0% contamination** (no draft record reaching an
injection, and drafts are what it plants) on real embeddings, and on the same run it
reports contradiction *detection* finding 1 of 5 planted contradictions. The gate holds;
the detector is a hint. Both numbers, and why the second one is structural, are in
[Measuring quality](#measuring-quality).

Runs local and embedded — better-sqlite3 + FTS5 + sqlite-vec, no server required.

## Less context, not more

Memory layers retrieve passages and paste them in. yoke injects **records** — a
decision with its rationale, a preference, a fact — already distilled, so every
token you spend is a claim rather than the prose around one.

Measured in a third-party harness —
[vectorize-io/agent-memory-benchmark](https://github.com/vectorize-io/agent-memory-benchmark)
running PersonaMem 32k, 42 questions over two users. yoke is only the memory arm; the harness owns
the dataset, the answering model and the judge. Answered and judged by `gemma-4-26b-a4b-qat`,
2026-08-15, result files in [`bench/`](bench):

| | injected context | accuracy |
|---|---|---|
| no memory | 0 | 59.5% (25/42) |
| **yoke** | **1.2k tokens** | **73.8% (31/42)** |

The floor is re-scored rather than quoted as printed: the harness marks any arm with empty context
wrong whatever it answered, so it reports 0.0% for no-memory while that arm actually answered 25 of
42. `node bench/rescore.mjs bench/results-*.json` is the scorer, and a floor deflated to zero is the
denominator of every "lift" a memory system publishes.

Against two chunk-retrieval baselines, on an earlier reader (`gemma-4-e4b`) where yoke scored 28/42
from the same 1.2k tokens:

| | injected context | accuracy | correct per 1k tokens |
|---|---|---|---|
| **yoke** | **1.2k tokens** | 66.7% | **23.5** |
| keyword chunks | 5.1k tokens | 61.9% | 5.1 |
| dense + sparse hybrid, top-50 chunks | 22.8k tokens | 71.4% | 1.3 |

**4.6× the answers per token of chunk retrieval, 18× that of the hybrid retriever.** The hybrid buys
the highest accuracy on that rig — 71.4% — with 19× the context, most of a small model's window spent
on one question.

Changing the reader moves every level, so those are one rig each and not one comparison: the baseline
arms have no result file in `bench/` yet, and re-running them on the current rig is what
`npm run bench` is for. What a *stronger* reader does is measured too, and it flatters no one: with
`gpt-5-mini` the floor rises to 24/42 and yoke to 25/42, because four-option multiple choice lets a
capable model reason the answer out unaided. Read any memory benchmark's accuracy as a statement
about its answering model first.

[`bench/README.md`](bench/README.md) has the rest, including the limit that matters most here: the
harness has no human, so the run opens the verification gate. It measures yoke's extraction and
retrieval — never its governance, which `npm run eval` is for.

Every record also arrives with its citation, which a pasted passage cannot do.

## At a glance

| | |
|---|---|
| **One-line summary** | A database optimized for knowledge: structure it as an ontology, then inject only the verified subset relevant to the current context into your AI — with citations. |
| **Front adapters** | An **MCP server** (`inject` · `commit` · `record_decision` · `overview` · `persona` · `use_scope`) and a **thin CLI**. Every AI tool is just an MCP client — no per-tool adapter. |
| **Storage backends** | `sqlite` (default, FTS5 + sqlite-vec) · `postgres` (native scored FTS + pgvector, no extra dependency) · `opensearch` (native BM25 + k-NN, no extra dependency) — point either remote one at the server your company already runs · `sharded` (federation by tenant). All four pass one conformance suite. |
| **Capture connectors** | `github-pr` (review comments), `slack` (channels + threads), `notes` (local transcripts), `adr` (decision records already on disk), `tracker` (Jira/Linear issues), `docs` (Confluence/Notion pages), `backstage` (a service catalog, verified with a TTL), `raw` (unstructured material — transcripts, docs — model-extracted) — external sources → draft knowledge, dated from the source. `rdb` (Postgres/MySQL read-mapping) maps a database that is already the system of record, so its rows land verified. |
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

Screens: the catalog, the scorecard, the review queue, conflicts, the ontology browser, persona preview, entity
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
yoke review [--stale] [--cluster]             # drafts awaiting review / verified past their TTL
yoke inject <query> [--include-draft] [--limit n] [--scope <id>] [--depth n] [--as-of ts]
yoke overview [--limit n] [--since ts]        # the corpus at a glance; --since adds capture density
yoke owner <id>                               # who is on the hook: author, group, work, last confirmer
yoke catalog [--owner g] [--stale]            # what the org runs, most-rotted first
yoke scorecard [--owner g]                    # four checks per catalog record, worst first
yoke graph [--limit n]                        # the corpus as edges
yoke conflicts | ontology <list|add-type> | rename-type <from> <to>
yoke persona <person-id> [--out dir] | persona --check <SKILL.md>
yoke history <id> | audit [--since ts] [--until ts] [--limit n] [--shape]
yoke connect github-pr|slack|notes|adr|tracker|docs|backstage|module|raw|rdb ...
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

**Injection quality** (`npm run eval`) — does the filter hold, and does the detection
find what it claims to. Measured 2026-08-17 with `bge-m3` behind `YOKE_EMBED_URL`, on a
60-record planted corpus:

| Metric | Definition | Target | Measured |
|---|---|---|---|
| Contamination rate | Share of draft entries among inject results | 0% | **0.0%** (only the 20 verified of 40 candidates were injected) |
| Missed-contradiction rate | Opposing-conclusion decision pairs with no conflicts_with edge | 0% | **80.0%** (1 of 5 detected) |
| False-conflict rate | Compatible same-topic pairs linked as conflicts anyway | 0% | **100.0%** (5 of 5) |

**The filter holds; the contradiction detector does not, and the reason is structural.**
Stage 4 only considers records the *duplicate* detector already raised, which means
cosine ≥ 0.85. On real embeddings a reversal reads as less similar than a restatement:
the five opposing pairs measured 0.803–0.866 (one above the line) while five compatible
refinements measured 0.859–0.924 (all five above it). So the gate selects for
restatement, which is exactly right for finding duplicates and backwards for finding
disagreements. The earlier 0% miss rate came from a stub embedder whose vectors were
built from the planted topic word — it proved stage 4 files an edge when handed a
candidate, never that a model would hand it one.

What that costs you today, stated plainly: `conflicts_with` edges you file yourself are
honoured everywhere — injection serves both sides marked as disputed, the conflicts
screen lists them — but **automatic detection cannot be relied on to find a
contradiction**, and it will link records that merely refine each other. Run
`npm run eval` yourself; without an embedder configured it falls back to the stub and
says so on every run.

Precision on the injection axis is `eval:retrieval` below, not this eval.

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

Precision is reported beside it and must be read against its own ceiling: **13.5%**
against a **16.5%** maximum at k=10. The gold set names fewer than two relevant records
per query, so eight of ten slots cannot be relevant no matter what retrieval does —
the figure is 82% of what is reachable, and the way to move it is a smaller k, which is
the same trade as the tokens-per-answer column above. Keyword-only scores a higher raw
precision (16.4%) purely by returning fewer records.

## yoke on yoke

The decisions behind v7 are recorded in yoke, and the agent that wrote it was injected with them. Six
decisions, each with its rationale and what it turned down, captured and verified on 2026-08-17:

```
$ yoke overview --since 2026-08-17T00:00:00Z
7 records, 6 relations
by type
  decision       6 verified
verified knowledge by author (from authored_by, not who promoted it)
     6  person:jhso
captured since 2026-08-17T00:00:00.000Z — 6 records, every status
     6  decision

$ yoke inject "why is contradiction detection only a hint"
[decision:01M0835FJF…@v2] person:jhso, 2026-08-17  The contradiction detector ships as a hint, not a mechanism…
```

The store itself is gitignored, like every other local database; the decisions in it are the ones this
branch's commits argue for, so the git log is the check on this being real. The retrieval numbers above
come from corpora anyone can load (`scripts/load-demo-corpus.mjs`), not from this.

## Docs

| Doc | What's in it |
|---|---|
| [VISION](docs/VISION.md) | Why yoke exists, the version scope, persona & shared context |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | The ports-and-adapters boundary |
| [KNOWLEDGE-POLICY](docs/KNOWLEDGE-POLICY.md) | The gate, lifecycle, and injection-filter rules |
| [SPEC](docs/SPEC.md) | The implementation contract — schema, port, gate, MCP tools, CLI |
| [WEB-UI](docs/WEB-UI.md) | The governance workbench — the twelve screens and the line we don't cross |
| [ROADMAP](docs/ROADMAP.md) | v0.1 → v6.1 built, in order, each section a record |
| [PLAN-V7](docs/PLAN-V7.md) | v7.0 → v7.6 planned — reproducible measurement, capture density, groups, the portal, distribution |
| [BACKENDS](docs/BACKENDS.md) | Adapter extension + RDB read-mapping (with live-verification notes) |
| [ENTERPRISE](docs/ENTERPRISE.md) | Multi-tenancy, auth, RBAC, replication, sharding |
| [MARKET](docs/MARKET.md) | Competitive landscape and positioning |

## License

MIT
