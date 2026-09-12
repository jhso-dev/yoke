# yoke — Research notes

Findings from outside this codebase that bear on design decisions not yet made. §1–4 are not
implemented; §5 partly is, and says which SPEC clauses it produced. It exists so that when the version
that needs it starts, the argument is already made and sourced instead of re-derived from memory.

**Scope note (2026-09-11).** §1–4 were gathered when promotion was a pre-use approval step; the
born-verified decision (ROADMAP v7.0) removed that step, so there is no approval to aggregate and
no pending-approval state to leak. The findings stand and still bind the decisions that remain
multi-person: resolving a `conflicts_with`, and any future design where more than one person's
judgment settles a record's fate. §5's freshness findings bind harder than before — the TTL lease
is now the primary weeder.

**Provenance of this file.** It was written from a research brief handed to the project on
2026-07-31, not from reading the primary sources. Paper titles and venues below are given as
identified; the effect sizes are quoted **as they appeared in that brief and have not been checked
against the papers**. That distinction is marked per claim and matters here more than most places —
this is a product whose thesis is that unsourced knowledge should be labelled as such.

---

## 1. Surprisingly Popular (SP) — how a group should decide, when it must

**Core idea.** Ask two questions instead of one: *your* answer, and *what you think most people will
answer* (the meta-prediction). Pick the answer that beat its own predicted popularity. A minority
answer that everyone expected to be rare, and which then turns out less rare than predicted, wins
over a majority answer that was exactly as popular as expected.

**Source.** Prelec, Seung & McCoy, *A solution to the single-question crowd wisdom problem*, Nature
541 (2017). The brief also cites a Bayesian extension in Management Science (2024); that citation is
**not verified here** and should be located before it is relied on.

**Reported effect** *(from the brief, unverified)*: error −21.3% against simple majority, −24.2%
against confidence-weighted voting.

**Why it belongs in yoke.** The mechanism assumes something this product already assumes elsewhere:
*a person who is right but in the minority knows their answer is unusual.* Majority rule discards
exactly that person. The meta-prediction is what recovers them.

**Where it would apply.** Re-confirming and retiring are the decisions about what an AI keeps
being allowed to believe. If either is ever made by more than one person, the aggregation rule is a
real design choice, and **majority is the wrong default**. `conflicts_with` resolution is the same
shape of decision and the same argument applies.

**Why nothing is implemented.** There is no vote to aggregate. `verify(port, ids, actor, now)` flips
status immediately; the first person with the permission decides, and no approval accumulates. SP
needs multiple votes plus a meta-prediction from each. Introducing that is a feature — schema for
ballots, a collection surface, an aggregation step — not a change to an existing one. The note here
is the design constraint for whoever builds it, not a request to build it.

---

## 2. Social influence degrades independence

**Finding.** Showing people others' estimates makes the group converge without becoming more
accurate: diversity falls, error does not. Classic source: Lorenz, Rauhut, Schweitzer & Helbing,
*How social influence can undermine the wisdom of crowd effect*, PNAS 108 (2011).

**Counterweight** *(from the brief, unverified)*: 2024 work reporting that under **structured**
deliberation social influence can improve accuracy. The distinction that matters is structure, not
exposure — which is what makes (3) below the operative design, rather than a blanket ban on people
talking to each other.

**Consequence for yoke.** Any multi-person confirmation screen that shows pending peer positions is
building the failure mode, not avoiding it — the first positions become the answer.

---

## 3. Policy Delphi — structured deliberation that preserves dissent

**Finding.** Anonymity removes hierarchy pressure; iteration refines positions. *Policy* Delphi
specifically targets **disagreement rather than consensus**: it exists to surface and preserve
opposing positions and their reasoning. Source: Turoff, *The design of a policy Delphi*,
Technological Forecasting and Social Change 2 (1970).

**Relation to yoke.** This is the human protocol version of `conflicts_with`: contradictions are
kept, both sides intact, rather than auto-resolved. The product already made this choice for stored
knowledge; Delphi is the same choice for the humans deciding about it.

**Status: a design constraint only.** There is no per-person approval state to leak — nothing
accumulates before a record stands. The constraint binds whoever builds multi-person confirmation
or conflict resolution, and should not be read as an implemented protection.

---

## 4. Meta-prediction identifies expertise without a track record

**Finding.** Who is expert can be identified from meta-predictions alone — no history of past
correctness required. Sister line of work to (1); the brief cites PLOS One and Management Science,
and those specific papers are **not verified here**.

**Where it would apply.** `persona` is a stored query over one person's standing knowledge. If
meta-prediction data ever exists, weighting a person's *minority positions that turned out right*
would make "what would Nathen say" mean something sharper than "what did Nathen write". Post-v1, and
strictly downstream of (1) — it needs the same data.

---

## 5. GraphRAG and enterprise knowledge platforms — where yoke actually sits

Added 2026-08-03, from an outside research summary dated 2026-07-08 (12 named companies, plus a
survey of GraphRAG implementation variants and enterprise-platform decision axes). Same provenance
caveat as the rest of this file: **the effect sizes below are quoted as that summary reported them and
have not been checked against the papers.** The summary itself flagged three of its numbers as
competitor-sourced or vendor-benchmarked, which is recorded here rather than dropped. Benchmarks it
cited: arXiv 2502.11371, 2604.09666, 2404.17723, 2506.06331.

**The finding that matters to us.** Graph retrieval wins on exactly three question shapes —
**multi-hop, temporal, and global aggregation** — and *loses* on single-hop factoid lookup, where
plain vector RAG scored higher (NQ: 64.78 vs 63.01). The reported temporal gain is +19–28pt; the
factoid loss is 1.7pt on one benchmark. **Those are different orders of magnitude and should not be
weighed equally**, which the source document's own layout does by giving each side an equal box.

**Why that puts yoke in the winning quadrant rather than the losing one.** A `decision` with
`supersedes` and rejected alternatives is a multi-hop, temporal record by construction: "what
replaced this" is a hop, "what was true then" is a clock. Across the 12 companies surveyed, graph
retrieval was actually deployed only where **the relation IS the answer** in a narrow domain (Uber
config consistency; LinkedIn ticket lineage, reported −28.6% median resolution time); general
document QA stayed vector or hybrid everywhere. That is the shape yoke has, and it is not the shape
the negative result is about.

**Where we were already on the cheap side.** The survey's construction axis runs from deriving
relations out of existing structure (no LLM cost) to extracting everything with an LLM (reported
40–57× the indexing cost of plain RAG), and it records the industry moving *toward* the cheap end
(LazyGraphRAG, Hebbia, Slack's federated no-index approach). yoke's relations enter explicitly
through the commit gate and are never LLM-extracted, so it starts at that end. **No change follows
from this** — it is recorded so nobody later proposes adding extraction as an improvement.

**Two gaps it named that were real, and are now closed:**

- **Temporal was stored but not queryable.** Append-only versions meant the data for "what was true
  then" was already there; there was no way to ask. Implemented as as-of injection (SPEC "As-of
  injection"). The survey's own framing of this — *invalidate, never delete* — is what yoke's
  append-only schema and `deprecate` already did.
- **Stale knowledge left injection silently.** The survey's sharpest operational claim is that
  flagging staleness does not fix it — routing it to a named owner for re-confirmation does. yoke did
  not even flag: `effectiveStatus` computed `stale` and dropped the record from injection with nobody
  told, while SPEC had promised a review surface since v1. Implemented as the stale queue (SPEC "The
  stale queue"), owner-first, because the owner was already recorded in `provenance.actor`.

**What we deliberately did NOT take from it.** The three-pipeline enterprise model (content ingest,
identity/permissions, governance) is a description of a product yoke is not: connectors are
peripheral here, and permissions activate only under `yoke serve --auth` (CLAUDE.md invariant 4). Its
buy-vs-build finding (76% buy) has a denominator of companies adopting an enterprise platform, which
is not the local-first single-user default. The five "axes" are also **not independent** — choosing
proposition-level granularity largely determines the retrieval-combination strategy — so treating
them as five free dials overstates the design space.

**The measurement this creates, and why it comes before any retrieval work.** The survey's central
claim is that *workload composition* decides whether graph investment pays: the ratio of multi-hop /
temporal / aggregate questions to simple lookups. **yoke has never measured its own.** docs/SCALE.md
measured size, not shape. Injection already writes an audit row, so the instrumentation was one
string: the `detail` subject now names the anchor and the as-of instant, which makes briefing / plain
query / anchored query distinguishable in the trail (SPEC "HTTP API", the `detail` shape table).

**Nothing further should be built on a guess about that ratio.** Read it out of the audit log first —
that is this section's operative conclusion, and it is the source document's own argument turned on
us. The read is `yoke audit --shape` (SPEC "HTTP API", the `detail` shape table): it was instrumented
in v5.2 and nothing consumed it, so the number existed and was still unknown. **Having the command is
not having the answer** — this note stayed open until a real trail had been read.

**Closed 2026-08-05, and the conclusion above was wrong — not the measurement, the inference.** The
trail read: 5 inject rows, 100% plain, 0% anchored. Multi-hop and aggregation were then held back on
the grounds that the workload did not ask for them. That reasoning is circular, and the circularity is
worth writing down because it is easy to mistake for rigour:

**this ratio measures adoption, and adoption of a capability that does not exist is necessarily zero.**
Nothing is in service; there are no users to generate anchored injections; anchored injections are the
thing multi-hop would deepen. A workload-composition gate is sound when it decides *between* built
capabilities competing for one corpus's traffic. It is not sound as a gate on building the capability,
because it always returns "no" — the source document's argument is about where to invest in a running
system, and it was applied to a system that has never run.

So multi-hop (SPEC "Multi-hop") and global aggregation (SPEC "Global aggregation") are built, and the
ratio stays instrumented for the question it can actually answer: once both exist and are reachable,
the trail says which shapes people use, and *that* is a number worth acting on.

### Measured 2026-08-03: the vector half was missing, and then it was misconfigured

Two findings while preparing for hybrid retrieval, both **measured here rather than quoted**, which is
why they are not marked unverified like the rest of this file.

**1. Coverage was accidental.** `.mcp.json` configures the embedder for the MCP server's process only,
and the CLI and web tier read `process.env`, so records created by a person arrived with no vector at
all. In this repo's own database: **1 of 3 entities had one.** In a 676-record corpus from a
templated generator (since removed — see `scripts/demo-corpus/README.md`): **0 of 676.** A hybrid retriever built on that would have had a
vector half that only saw whatever an agent happened to commit. Repaired by `yoke backfill
--embeddings` (both are now 3/3 and 676/676).

**2. The embedding model decides whether the vector half works at all — in Korean, `nomic-embed-text`
does not.** Eight Korean queries phrased with different vocabulary than the record that answers them,
over twelve records including four lexical decoys (surface words shared with a query, meaning not):

| model | accuracy@1 | mean top1−top2 margin | FTS on the same queries |
|---|---|---|---|
| `nomic-embed-text` (768d) | **2/8 (25%)** | 0.015 | 0/8 |
| `bge-m3` (1024d) | **8/8 (100%)** | 0.126 | 0/8 |

`nomic` is not merely weaker, it is near-random on this corpus and its errors are absurd (a query
about retry budgets ranked an insurance-premium record first). An English-centric model on
non-English knowledge produces a system that looks configured and retrieves noise — worse than an
unconfigured one, which at least says so.

**FTS scored 0/8 on every query.** That is the "complements, not substitutes" claim from the survey
above, demonstrated on our own data rather than cited: these are precisely the questions the keyword
half cannot answer, and the vector half now can. It is also the strongest available argument for B1
(hybrid retrieval in `inject`), which was built the next day — see below.

Method: `bge-m3` served by Ollama (1.2GB, MIT, 8192-token context). Absolute cosine is deliberately
not compared across models — the scales are not commensurable — so the discriminating number is
accuracy@1 and the top1−top2 margin within each model.

### Measured 2026-08-04: hybrid retrieval, and why the keyword half returned nothing

B1 shipped (SPEC "Hybrid retrieval"). The measurement above went through `similar()` directly; this
one goes through `inject()`, which is the only path an agent can reach. Twelve Korean records (eight
answers, four lexical decoys), eight questions phrased with no content word in common with the record
that answers them, `limit: 5`:

| | accuracy@1 | hit@5 |
|---|---|---|
| keyword-only (v5.2 behaviour) | **0/8** | **0/8** |
| hybrid (`bge-m3` + RRF) | **7/8** | **8/8** |

**The keyword half returned literally nothing — and not because of Korean.** `search` is
AND-of-prefix-tokens: every query term must appear (storage-sqlite, deliberate — the whole-phrase
match it replaced silently missed multi-word queries). A question is a sentence, so the conjunction is
unsatisfiable by construction. Probed by removing one token at a time from `인덱스 다시 만드는 배치는
언제 도나요`: **0 hits at two tokens, 1 hit at one.** Keyword-shaped queries hit correctly on the same
corpus (`색인` → the right record, `야간` → two), so FTS is not broken on Hangul — **the query shape is
what fails, and an English sentence fails it identically.** Any measurement that quotes FTS recall
without saying whether the queries were sentences or keywords is measuring the shape, not the index.

**The one failure is the honest ceiling.** For `인덱스 다시 만드는 배치는 언제 도나요` the vector half
ranked the decoy `인덱스 펀드 수익률 보고서` first and the answer (`야간 색인 재생성`) fourth — the
answer says 색인 where the question says 인덱스, and the decoy shares the salient token. So a shared
salient term can fool the vector half too. It still reached the agent inside `limit: 5`, but the reason
nothing corrected it is structural: **when one half returns nothing, RRF degenerates to the other
half's own order and there is no agreement signal left.** Fusion adds robustness only where both
halves retrieve. That is an argument for A2/A3 (a gold set and recall/nDCG) rather than for tuning
against eight queries, and an argument against ever reporting a fused number without reporting each
half's.

### Measured 2026-08-04 (2): the gold set, and what the keyword half is actually for

The eight-query test above could not say how often RRF degenerates, only that it does. `eval/gold-set.json`
answers it: 66 queries against the 504-record demo corpus, each naming the records that answer it,
scored through `inject()` at k=10 (`npm run eval:retrieval`). Two query **shapes**, because the first
draft of the set contained only one and that turned out to be the whole story:

| | keyword | hybrid |
| --- | --- | --- |
| **question** (55) — a sentence, how an agent's user asks | recall@10 **0.0%**, acc@1 **0.0%** | recall@10 **84.7%**, acc@1 **58.2%** |
| **keywords** (11) — one to three terms, how a person searches a wiki | recall@10 **90.9%**, acc@1 81.8% | recall@10 **100%**, acc@1 100% |
| all 66 | recall@10 15.2%, nDCG 14.1% | recall@10 87.2%, nDCG 74.3% |

Three findings, in order of what they cost:

1. **RRF degeneracy is not an edge case in this workload — it is all of it.** On every one of the 55
   question-shaped queries the keyword half returned zero rows, so the fused result *is* the vector
   list, unchecked. The v5.3 ceiling was stated as a caveat; at 55/55 it is the operating condition.
2. **Which makes the embedder load-bearing rather than optional.** `makeFetchEmbedder` returning
   `null` is documented as "retrieval falls back to FTS", and this is what that fallback is worth for a
   question: **nothing**. A deployment with no embedder configured answers an agent's question with an
   empty result set, silently.
3. **The keyword half is not broken, and the fix is not in the ranker.** Given a query shaped like a
   query it recalls 90.9%. `search` is AND-of-prefix-tokens (conformance case 6c pins it deliberately),
   so a 12-token sentence is an unsatisfiable conjunction — verified directly against the corpus:
   `"결제대행사 승인 요청 타임아웃"` → 1 hit, `"타임아웃"` → 3, the full question → **0**. The
   candidate fix is a minimum-should-match rule that keeps AND for short queries and requires a
   fraction of terms for long ones. That is a change to a contract clause, not a tuning knob, so it
   belongs in SPEC before it belongs in four adapters. *(Shipped the next day as SPEC search clause 8 —
   boolean rather than fractional, for the reason in the section below.)*

**Two engines, one number.** The same gold set through sqlite (FTS5 + sqlite-vec) and through
OpenSearch (BM25 + HNSW k-NN) scores recall@10 87.2% on both, nDCG 74.3% vs 74.4%, accuracy@1 65.2% on
both. They differ on one keyword query's rank-1 pick (81.8% vs 90.9% acc@1 in that cohort), which is
two BM25 implementations disagreeing about one tie. Invariant 2 says backend behaviour must not leak
into core; this is the first measurement that could have shown a leak, and it does not.

What the set does **not** measure, stated so nobody reads it as more than it is: relevance is binary
and mine, one language, one corpus, and no query needs more than one hop. Its value is as a baseline —
the next retrieval change now has a number to beat instead of an argument.

### Measured 2026-08-05: the disjunction, and the regression it hid one layer up

The fix from finding 3, measured on the same set. `search` now requires every term up to three and any
term beyond that (SPEC clause 8). On sqlite, keyword-only:

| | before | after |
| --- | --- | --- |
| **question** (55) | recall@10 0.0%, acc@1 0.0%, 0/91 found | recall@10 **51.1%**, acc@1 **29.1%**, **41**/91 found |
| **keywords** (11) | recall@10 90.9%, acc@1 81.8% | recall@10 **95.5%**, acc@1 81.8% |
| all 66 | recall@10 15.2%, nDCG 14.1% | recall@10 **58.5%**, nDCG **45.8%** |

The keyword cohort **improving** was the surprise: a four-term keyword query had been hitting the same
wall as a sentence, so "short queries were fine" was true only of the ones shorter than four terms.

**Then the hybrid column moved the other way**, which is the finding worth keeping. Fusing the new
keyword list at equal weight scored recall 84.2% / nDCG 67.4% / acc@1 **53.0%** against v5.5's
87.2 / 74.3 / **65.2** — a 12-point accuracy@1 regression on the path we recommend, produced by a
change that improved every keyword-only number. The mechanism: RRF reads positions only, so a keyword
rank 1 and a vector rank 1 score identically, and the keyword half's rank 1 on a disjunctive query is a
record sharing one word with the question. While that half returned *nothing*, its precision never
mattered; clause 8 gave it a voice before anything had checked whether it deserved an equal one.

Weighting the keyword half (`1/(60+rank)` scaled, still rank-based) and sweeping:

| weight | 1.0 | 0.5 | 0.3 | 0.2 | 0.1 | 0.05 |
| --- | --- | --- | --- | --- | --- | --- |
| recall@10 | 84.2% | 85.7% | 87.2% | 88.0% | **88.4%** | 88.0% |
| accuracy@1 | 53.0% | 57.6% | 59.1% | 65.2% | **65.2%** | 65.2% |

0.1 ships. Two things about that number: the top is a **plateau** (0.05–0.2 tie on accuracy@1), which
is the difference between a measurement and an overfit; and at 0.1 the keyword-shaped cohort is
untouched at 100% recall / 100% acc@1, so the downweight costs the queries the AND was right about
nothing at all.

The generalisable lesson is not about weights. **A retrieval change was measured on the metric it was
designed to move, improved it by 43 points, and silently cost 12 on a different configuration of the
same system.** The gold set caught it only because it scores both columns on every run — a report that
printed the column being worked on would have called this an unqualified win.

---

## 6. Pulse baseline — the loop's health before anything tried to move it

`yoke audit --pulse` (v7.1) exists so the v7.x capture work is judged by before/after numbers
rather than by having shipped. This is the BEFORE, taken 2026-09-12 against this repository's own
`yoke.db` (the auth/born-verified decision corpus) — recorded with its own caveats attached,
because the numbers say almost nothing yet and pretending otherwise would launder tooling into
verdicts:

| pulse metric | 2026-09-12 | what the number can and cannot say |
|---|---|---|
| capture | 15 records, 1 judgeable: 1 human, 0 agent, 0 connector — hands-free 0% | 14 heads carry `origin: lifecycle` (promoted under the pre-v7.0 model), so their capture class is unjudgeable. The 0% hands-free is a fact about one judgeable record, not about the loop |
| delivery interrupts | 0 instrumented rows; 1 pre-instrumentation row skipped | the `changed=` token shipped with the same commit as the metric — every delivery before it is unjudgeable. The v7.0 ceiling (interrupt cost unmeasured) stays open until real deliveries accumulate |
| recall reach | 0/0 | no retirement has chased a delivery in this corpus yet |
| relitigation | 1/1 superseded decisions reversed within 14d | the one data point is the verifiers-scope decision, reversed a day after birth by the born-verified redesign — a true positive, and a reminder that n=1 |
| briefing share (the collaboration scope) | 7/11 decisions+terms | pre-v7.2; the number the briefing-ordering change must not regress |

The tool is ready; the answer is pending. The judgment this baseline exists for — did v7.3/v7.4
raise hands-free capture, did v7.2 hold the briefing's decision share under noise, what is the real
interrupt rate — needs four weeks of live traffic (the plan's soak window), not this table.

---

## 7. The efficiency formula, and why it ends on a break-even

`yoke audit --roi` answers "is this worth running" in human-minutes over the window the audit query
bounds. Both sides are deliberately small, and the report never mixes what the trail measured with
what the caller assumed.

```
saved  = propagation + rework
         propagation = Σ over decision-deliveries max(0, baseline_hours − lag_i)
                       × act_rate × stale_minutes_per_hour
         rework      = recall/reversal deliveries × build_rate × unwind_minutes
spent  = by-hand records × file_minutes
       + re-confirmations and retirements × weed_minutes
       + injected tokens ÷ 1000 × read_minutes_per_1k
E      = saved ÷ spent
```

**Measured** (audit trail + records): decision deliveries and each one's lag from the record's own
event time, recall/reversal count (the `changed=` token), records filed by a person versus by an
agent or connector, weeding actions, injected volume. **Assumed** (`--assume k=v`, defaults listed
by the command): the six behavioural constants no trail can see.

Three modelling decisions, each made after the naive version produced a number that flattered the
product:

1. **Per delivery, not off a median.** A record handed over later than the team would have learned it
   anyway earns nothing. Averaging let a backfill of historical PRs — most of what a first import
   delivers — collect propagation credit for reaching people "quickly": 59x on the rig, against 8x
   once each delivery was clamped on its own lag.
2. **Decisions only.** Crediting every delivered record with "someone would have needed this a day
   later" is the assumption doing the work rather than the loop. The product's claim is the decision
   flow; the formula claims no more than that.
3. **Pessimistic defaults.** Every constant sits at the low end of what a team would plausibly claim,
   so the answer errs toward "not worth it". A measurement that flatters what it measures is not
   worth running.

The headline is the **break-even**, not the ratio: the ratio is only as good as six numbers nobody
measured, while the break-even is one sentence a team can check against its own week — *"we would
have learned that decision within N hours anyway"*. When the recall term alone already exceeds the
cost, the report says that instead, because then the propagation constants do not matter at all.

Rig reading, 2026-09-12 (day 0, and mostly backfill — not a verdict): 65 decision deliveries of
which 21 inside the 24h window, 5 recalls; 164.7 minutes saved against 19.6 spent at the default
constants, with the recalls alone (45 min) already covering the cost. What this says today is that
the formula runs and that the cheap half pays; what it will say in four weeks is the point.

---

## 8. Contradiction detection is similarity-gated, and a reversal is not similar

Measured 2026-09-12, bge-m3 through a local Ollama, reproducing a finding first made on an
unmerged branch (`archive/v7-bench-and-scorecard`) and independently confirmed here.

`npm run eval` reported 0% missed contradictions for as long as it has existed. That number came
from a **stub embedder** that emits one vector per topic keyword, so every planted pair scored 1.0
and detection was true by construction. Run against real vectors, the same corpus gives **1 of 5**.

Why, measured on Korean decision pairs:

| pair | cosine |
|---|---|
| "재시도는 3회" vs "재시도는 하지 않는다" (opposing) | 0.710 |
| "세션 상한을 올린다" vs "올리지 않는다" (opposing) | 0.753 |
| "캐시는 LRU" vs "캐시는 TTL" (opposing) | 0.664 |
| "재시도는 3회" vs "재시도는 3회, 백오프는 지수" (compatible refinement) | 0.872 |
| "캐시는 LRU" vs "캐시는 LRU, 크기 1000" (compatible refinement) | 0.785 |

Gate stage 4 only judges pairs the DUPLICATE detector raised, at `DUP_THRESHOLD = 0.85`. Opposing
conclusions sit **below** it; a compatible refinement sits **above**. The stage inherits a
similarity question to answer a contradiction question, and similarity ranks them backwards — the
detector selects for restatements.

Lowering the threshold does not fix it, it admits the refinements first. What fixes it is asking
whether two conclusions contradict rather than whether they resemble each other: an entailment
call (a small NLI model, or the model already in the loop), scoped to decisions on the same
subject. That is a design decision with a cost — a second model on the write path — and it is
unbuilt. Until it is, **`conflicts_with` is a claim the writer makes, not one the gate reliably
finds**, and everything downstream (injection serving both sides marked, the unseen ledger's
contradicted line) is only as good as what someone recorded by hand. The eval now prints which
embedder ran, so a stub 0% can never again be read as a measurement.

## 9. Derivation closure — the transitive walk has an empty target population

Measured 2026-08-07. `yoke deprecate` reports the records that declared they rest on what was
retired — **one `derived_from` hop**. The obvious upgrade is the transitive closure, and it was
carried as a ceiling to lift "if a real corpus turns up chains deep enough that one hop misleads".
This is that check, run before building it.

Three corpora were generated by three independent LLM simulations of real teams (payments backend,
data platform, mobile release), each ~5 months of accretion: 75–83 records, sparse `derived_from`
edges as the simulated authors would actually cite, chains to depth 4. The generators were blind to
the hypothesis. Each corpus carries 5 deprecation events with a **semantic** ground truth — the
records a steward with full knowledge should re-examine, labeled `invalidated` or `survives`, judged
from the record texts rather than by walking the graph. The same author wrote both the edges and the
ground truth, which biases the experiment in the closure's favour.

15 events, 23 invalidated / 69 re-examine:

| mechanism | recall on invalidated | recall on all re-examine | noise |
|---|---|---|---|
| one hop (shipped) | 0.48 | 0.26 | 0 |
| iterative (one hop + retire + repeat) | 0.48 | 0.32 | 0 |
| **transitive closure** | **0.48** | 0.35 | 3 |

Ground truth by graph distance from the deprecated record:

| verdict | direct (1 hop) | transitive (≥2) | no path at all |
|---|---|---|---|
| invalidated (23) | 11 | **0** | 12 |
| survives (47) | 8 | 6 | 33 |

1. **The closure's target population is empty.** Across 15 events in three independent corpora, not
   one truly-invalidated record sat at graph distance ≥ 2. Chains existed; invalidated records at
   the end of them did not. The closure would have added 6 records that survive anyway, plus the
   only noise in the whole experiment.
2. **The binding constraint is citation coverage, not walk depth.** 12 of 23 invalidated records
   (52%) had **no `derived_from` path at all** — the dependence was real but never declared as an
   edge, typically a fact that *measured* the retired thing's world, or a sibling resting on an
   uncited premise. No walk of any depth reaches these.
3. So one hop stays, and `downstreamOf`'s ceiling cites this rather than waiting on chain depth.

Caveat: synthetic corpora, and 23 invalidated ground-truth records is small. The result holds across
all three domains and the setup favoured the closure, which is what makes a null result worth acting
on. Re-run against a real corpus once one has accumulated enough `derived_from` history to label —
which needs new ground-truth labelling either way. The corpora and harness this used are in git at
`eval/derivation-closure/`, removed after the finding was recorded here.

---

## How to use this file

Cite it from the design document that owns the decision, rather than copying the argument. Current
hook: the scope note above, which binds any future multi-person confirmation design. When a claim here is checked against its primary source, replace the
"unverified" marker with the page reference — the marker is a debt, not a disclaimer.

§1–4 are unimplemented; §5 is **partly implemented** and names the two SPEC clauses it produced; §6
is a dated measurement that `audit --pulse` re-takes, §7 the formula `audit --roi` computes, §8 a
measured limit that bounds what `conflicts_with` can be claimed to do, and §9 the null result that
holds `downstreamOf` to one hop. Where a section drives code, it says which
code — so the next reader can tell the argument from the artifact.
