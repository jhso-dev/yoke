# yoke — Research notes

Findings from outside this codebase that bear on design decisions not yet made. Nothing here is
implemented. It exists so that when the version that needs it starts, the argument is already made
and sourced instead of re-derived from memory.

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

## How to use this file

Cite it from the design document that owns the decision, rather than copying the argument. Current
hooks: `ENTERPRISE.md` (the verify permission model) and `WEB-UI.md` (the review screen's
independence constraint). When a claim here is checked against its primary source, replace the
"unverified" marker with the page reference — the marker is a debt, not a disclaimer.
