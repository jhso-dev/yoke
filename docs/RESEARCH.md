# yoke — Research notes

Findings from outside this codebase that bear on design decisions not yet made. §1–4 are not
implemented; §5 partly is, and says which SPEC clauses it produced. It exists so that when the version
that needs it starts, the argument is already made and sourced instead of re-derived from memory.

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

**Where it would apply.** `verify` is the knowledge-governance permission (ENTERPRISE.md) — the
decision about what an AI is allowed to believe. If that decision is ever made by more than one
person, the aggregation rule is a real design choice, and **majority is the wrong default**.
`conflicts_with` resolution is the same shape of decision and the same argument applies.

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

**Consequence for yoke.** Any multi-reviewer `verify` screen that shows pending peer approvals is
building the failure mode, not avoiding it — the first approvals become the answer.

---

## 3. Policy Delphi — structured deliberation that preserves dissent

**Finding.** Anonymity removes hierarchy pressure; iteration refines positions. *Policy* Delphi
specifically targets **disagreement rather than consensus**: it exists to surface and preserve
opposing positions and their reasoning. Source: Turoff, *The design of a policy Delphi*,
Technological Forecasting and Social Change 2 (1970).

**Relation to yoke.** This is the human protocol version of `conflicts_with`: contradictions are
kept, both sides intact, rather than auto-resolved. The product already made this choice for stored
knowledge; Delphi is the same choice for the humans deciding about it.

**Status: partially in place, as a design hook only.** `PLAN-V2.md` records "the review queue does
NOT show other reviewers' pending approvals", and `src/front/ui/server.ts` carries the note at the
route. Both are promises about a future version — **there is no per-reviewer approval state today to
leak**, so the guard currently constrains nothing. It is a constraint on the design of multi-reviewer
verify when that is built, and should not be read as an implemented protection.

---

## 4. Meta-prediction identifies expertise without a track record

**Finding.** Who is expert can be identified from meta-predictions alone — no history of past
correctness required. Sister line of work to (1); the brief cites PLOS One and Management Science,
and those specific papers are **not verified here**.

**Where it would apply.** `persona` is a stored query over one person's verified knowledge. If
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
us.

---

## How to use this file

Cite it from the design document that owns the decision, rather than copying the argument. Current
hooks: `ENTERPRISE.md` (the verify permission model) and `WEB-UI.md` (the review screen's
independence constraint). When a claim here is checked against its primary source, replace the
"unverified" marker with the page reference — the marker is a debt, not a disclaimer.

Amended 2026-08-03: §5 is the first section here that is **partly implemented**, which changes what
this file is for. The header still says "nothing here is implemented" about §1–4, and that stays
true. Where a section drives code, say which code — §5 names the two SPEC clauses it produced, so the
next reader can tell the argument from the artifact.
