# Benchmarking yoke against other memory systems

`yoke_provider.py` plugs yoke into [vectorize-io/agent-memory-benchmark][amb], which runs PersonaMem,
LoCoMo, LongMemEval, BEAM and LifeBench through one ingest → retrieve → generate → judge harness.

The harness owns the datasets, the answering model and the judge. yoke is only the memory arm, so
the comparison against `fullcontext` (no memory system, whole history in the prompt) and `bm25` is
apples to apples.

[amb]: https://github.com/vectorize-io/agent-memory-benchmark

## What the number will and will not mean

Read this before quoting a score anywhere.

**The gate is bypassed.** yoke's central claim is that a human verifies knowledge before an agent can
read it. An automated benchmark has no human, so the provider runs `verify --all-drafts` after every
ingest. What gets measured is yoke *with the gate open* — its extraction and retrieval. Its
governance is not measurable here at all, by anyone, and a memory benchmark is the wrong instrument
for it. `npm run eval` is the one that measures governance (contamination and missed-contradiction
rates), and it is ours rather than an industry standard, which is the trade.

**Half the score belongs to the extraction prompt.** Documents arrive as raw conversation. What a
query can find depends on what `src/connectors/extract.ts` decided to file, so a low number does not
separate "yoke retrieves badly" from "this prompt extracted badly" — and those have different fixes.
Always run the baselines in the same command; they are what make the middle term readable.

**Every other published number has the same problem.** The 48% → 76% that TencentDB Agent Memory
reports on PersonaMem is its extraction prompt (75 KB of them) at least as much as its storage, and
the repository contains no harness, dataset, or reproduction script — the string "personamem" appears
only in its two READMEs. That is the norm in this space, not an outlier, which is the reason to run
a third-party harness rather than publish a self-measured figure.

**Compare lifts, not levels, and know what the baseline was.** An absolute score is mostly a
statement about the answering model — the published PersonaMem leaderboard has cognee at 81.8% and
hindsight at 86.6% over 589 queries with a frontier answerer, while a small local model puts every
arm in the forties. What survives the swap is the ratio between an arm and its no-memory baseline,
which is the shape a "48% → 76%" claim is in. But that baseline is the *whole history in the prompt*,
not an empty one: `--memory none` returns no context, and the runner marks an empty context wrong
before scoring, so it measures a structural zero rather than a baseline. Use `--memory fullcontext`
(`src/memory_bench/memory/fullcontext.py`) for the arm those claims are actually measured against,
and check the context-window trap below first — at 32k the prompts are large enough to hit it.

## Setup

No API key is needed for any of it. The harness can answer and judge through any OpenAI-compatible
endpoint, so one local server can fill all three roles — yoke's extractor, the answering model, and
the judge. Verified end to end against LM Studio serving Gemma 26B, including the harness's strict
`json_schema` structured output, which LM Studio supports.

```bash
# 1. yoke on PATH, pointed at your endpoint
npm install && npm run build && npm link
export YOKE_LLM_URL=http://<host>:1234/v1     # API ROOT — /chat/completions is appended
export YOKE_LLM_MODEL=<model-id>              # exactly as /v1/models reports it

# 2. the harness
git clone https://github.com/vectorize-io/agent-memory-benchmark && cd agent-memory-benchmark
uv sync

# 3. register the provider
cp /path/to/yoke/bench/yoke_provider.py        src/memory_bench/memory/yoke.py
cp /path/to/yoke/bench/fullcontext_provider.py src/memory_bench/memory/fullcontext.py
```

Then four lines in `src/memory_bench/memory/__init__.py`:

```python
from .yoke import YokeMemoryProvider                  # with the other imports
from .fullcontext import FullContextMemoryProvider
REGISTRY["yoke"] = YokeMemoryProvider                 # in the registry dict
REGISTRY["fullcontext"] = FullContextMemoryProvider
```

And the environment that points answering and judging at the same endpoint:

```bash
export OPENAI_BASE_URL=http://<host>:1234/v1  # the OpenAI SDK reads this itself
export OPENAI_API_KEY=unused                  # LM Studio ignores it; the SDK requires something
export OMB_ANSWER_LLM=openai OMB_ANSWER_MODEL=<model-id>
export OMB_JUDGE_LLM=openai  OMB_JUDGE_MODEL=<model-id>
export GEMINI_API_KEY=unused-openai-path      # see "Traps" below
export SDE_CONCURRENCY=1                      # see "Traps" below
```

## Traps, all of which fail quietly

Each of these was hit on a real run. None announces itself.

**An overrun context window returns an empty answer, not an error.** Measured against LM Studio
serving `gemma-4-e4b`: a 10,933-token prompt was answered correctly, a 28,933-token one came back as
`""` in five seconds. The scorer marks an empty answer wrong, so a long-context arm silently becomes
a near-zero baseline — and a near-zero baseline is what makes a memory system look transformative.
Check `loaded_context_length` on the server (`/api/v0/models` on LM Studio) before running any arm
whose prompts are large, and treat an empty completion as a failure rather than an answer. The
provider's local patch to `src/memory_bench/llm/openai.py` raises on one, naming the token count.

**The runner scores any arm with empty context wrong, whatever it answered.** `runner.py` has
`elif not answer_result.context: correct, judge_reason = False, "empty context — no memories
retrieved"` before the MCQ scorer. The model is still asked and its letter is still recorded — only
the scoring is short-circuited. So `--memory vanilla`, the no-memory arm, reports 0/19 while having
actually answered 8 of them, and that zero is the denominator of every "lift" a memory arm claims.
Re-score it yourself from `answer` against the last element of `gold_answers`:

```python
def correct(r):
    a = (r.get("answer") or "").strip().lower()
    g = r.get("gold_answers") or []
    return bool(a) and a[:1] == ((g[-1] or "").strip().lower()[:1] if g else "")
```

On two PersonaMem users this moved the floor from 0% to 47.6% (20/42) — bm25's lift went from "∞" to
×1.30. A trivial keyword baseline getting ×1.30 is also the scale to read any published lift against.
Check `empty-ans` on the floor arm while you are there: an unanswered question is not a wrong one, and
user 1's floor rested on 3 of them (user 2's, re-run later, had none).

**Extraction is not reproducible at `YOKE_EXTRACT_CONCURRENCY > 1`, even at temperature 0.** The same
document (39,154 characters, 7 chunks), the same model, the same code, extracted three times at
concurrency 4, yielded **27, 25 and 18 records**. The extractor sends `temperature: 0`, so this is not
sampling — it is batched inference: with four requests in flight the server's batch composition differs
per run, floating-point reduction order changes with it, and a greedy argmax between two near-tied
tokens flips. A different token early in a JSON array is a different set of records.

Two consequences, and the second is the one that bites:

- A record-count difference between two stores is **not** evidence about a code change. A ±35% spread
  swallows most effects worth measuring. Run concurrency 1 for a reproducible store, or extract the
  same corpus three times and report the range.
- Every yoke arm score is a **single draw** from that distribution, because each arm is answered
  against one store. The 42-question numbers here are one sample, not a point estimate, and the
  paired tests below understate the true uncertainty accordingly.

**Reordering the injected records chronologically is a NET LOSS — measured, and do not re-run it.**
`inject` returns relevance order, and the harness renders `## Memory 1..N` with no dates
(`modes/rag.py`), so list position is the only order signal the answering model gets. On a
trajectory question that reads as a reversed history: "Stepped back from readathons" arrived as Memory
1 and "decided to try the readathon, motivated by a friend" as Memory 3, and the question was which
came first. Sorting by source order fixes exactly that, and costs more than it earns:

| question type | n | relevance order | source order |
| --- | --- | --- | --- |
| track_full_preference_evolution | 16 | 9 | **10** |
| recall_user_shared_facts | 8 | **7** | 4 |
| recalling_the_reasons_behind_previous_updates | 6 | **6** | 5 |
| other | 12 | 6 | 7 |
| **total** | **42** | **28** | **26** |

The trajectory gain is real and it is one question. Recall loses three: those questions need the
single most relevant record, and chronological order buries it mid-list where the model attends to it
less. Position bias is worth more here than order information.

The lesson generalises past this arm: **order is a bad channel for stating order.** A relation says
"this replaced that" without moving anything, which is why `yoke relate` and not a sort is where the
trajectory work goes. `YOKE_BENCH_PROBE_ORDER=1` on the yoke provider still reproduces the losing
configuration, kept so the next person can confirm rather than re-derive.

Also: 19 questions cannot see a difference this size. On user 1 alone the sort scored **11/19 → 12/19**
and looked like a win. The second user reversed it 17/23 → 14/23. Nothing here is worth acting on at
n=19.

**Field order in a structured-output schema decides what survives truncation.** Grammar-constrained
decoding emits properties in schema order, so a schema listing `reasoning` before `choice` spends the
token budget on the explanation and loses the letter being scored. See the section below for the
measured cost. Put the scored field first.

**A killed run leaves its child processes writing.** `pkill -f "amb run"` ends the Python process and
not the `yoke connect raw` it spawned, which keeps writing to the same sqlite file while the next run
starts against it. Kill by the temp directory in the child's argv, and check `ps` before relaunching.

**A local model can hang forever on one query, and it is the model's fault, not the server's.**
The first arm stalled with retries exactly 600s apart — the OpenAI SDK's client timeout, not a server
error. `/v1/models` answered in 18ms throughout and the same prompt without `response_format`
answered in 7s, so neither the endpoint nor the network was implicated. Capping `max_tokens` showed
what was actually happening: asked for JSON with a `reasoning` field, the model degenerated into
`"The user is asking for a conversation-style. conversation-style. conversation-style. …"` and never
emitted the closing brace, so the response never completed.

**The cap that fixes it has a floor as well as a ceiling, and both ends fail differently.** Measured
on `gemma-4-e4b` over PersonaMem 32k queries: uncapped hangs indefinitely; `max_tokens=700` truncates
the JSON mid-string and `json.loads` raises, which propagates out of the runner and **ends the whole
evaluation**, discarding every query already scored; `max_tokens=1200` answered 8 of 8 in 3–11s.
Set `OMB_MAX_TOKENS` between those, and set `OMB_TOLERATE_BAD_JSON=1` so a query the model still
cannot answer is scored wrong instead of killing the run. Both are local patches to
`src/memory_bench/llm/openai.py`, env-gated so upstream behaviour is the default — neither changes
what is asked or how it is scored.

**Verify your model on one real query before starting a run.** Take a query from the split, wrap it
in the harness's own MCQ schema, send it with `max_tokens` set, and check `finish_reason` and that
the content parses. If it is `length` or the JSON is truncated, raise the cap; if it never returns,
change models. Two of the three models on the test server never became usable: `gemma-4-26b-a4b-qat`
degenerated as above, and `ornith-1.0-35b-mlx` returned empty content with every token spent on
reasoning.

**`--query-limit` is applied before `--unit`.** Passing both takes the first N queries in the file and
*then* filters them to the unit, which usually leaves zero. The run completes and reports
`Total queries 0, Accuracy 0.0%` — a plausible-looking failure, and 0% is a number somebody will
quote. Use `--unit` alone, or `--query-limit` alone.

**The CLI demands `GEMINI_API_KEY` even when nothing will call Gemini.** `_resolve_gemini_key()` is an
unconditional startup gate (`src/memory_bench/cli.py`), unaffected by `--llm openai`. Set it to any
placeholder: on the openai path the value is never read, and if Gemini somehow *is* reached the call
fails loudly on auth rather than silently scoring against a different model.

**Concurrency comes from the memory provider, not a flag.** The runner reads
`getattr(memory, "concurrency", 4)`. `vanilla` takes it from `SDE_CONCURRENCY` (default 4), so the
baseline arm fires four concurrent requests at a single-GPU server that cannot take them — measured:
4 requests succeeded, 7 retried, and the run stalled without ever writing a result. `yoke`'s provider
pins 1; set `SDE_CONCURRENCY=1` so the other arms match, which also keeps the comparison fair.

**Splits are big, and `--unit` is how you make a first run finish.** PersonaMem 32k is 195 documents
(median 23,631 characters), 37 users, 589 queries. At local-model speed the whole split is tens of
hours. One unit — `--unit <user_id>` — is four documents and ~19 queries, which is enough to see that
an arm runs and **not** enough to rank two arms: measured, two yoke variants both scored 5/19 while
agreeing on only one of the five (McNemar p=1.0). Use one unit to debug the plumbing, then several
for any number you intend to quote. Upstream `--unit` takes a single id; the one-line patch making it
comma-separated is in `src/memory_bench/runner.py`:

```python
wanted = {u.strip() for u in str(unit).split(",") if u.strip()}
queries = [q for q in queries if str(q.user_id) in wanted]
```

Pick by query count rather than by size — the questions are what n is:

```python
import gzip, json, collections
qs = json.loads(gzip.open("data/personamem/32k/queries.json.gz").read())
c = collections.Counter(q["user_id"] for q in qs)
print(",".join(u for u, _ in c.most_common(5)), sum(n for _, n in c.most_common(5)), "queries")
```

### More context is not more correct — measured twice

Injecting the WHOLE verified store (~3k tokens, still under bm25's 5,120) scored 22/42 against the
28/42 baseline. The evidence records were IN the context and the answering model still missed them:
`suggest_new_ideas` stayed 0/2 with the needed preference present but buried at position ~40, and
`recall_user_shared_facts` collapsed 6 → 2. With a small answering model, precision of the head is
the whole game — do not pay for recall with tail noise.

### The hybrid fusion weight is a per-corpus decision, and this corpus splits

`YOKE_KEYWORD_WEIGHT` (core default 0.1, swept on yoke's own gold set): u1 wants the vector half
(FTS 11 → hybrid 13 at either weight), u2 wants the keyword half (FTS 17, w0.1 12, w1.0 15 —
`recall_user_shared_facts` 6/1/3). Both totals land on 28/42. Per-user weights would be overfitting
to n=42; a swept weight must be validated on users the sweep never saw.

### The lift is a property of the answering model, measured three ways

Same stores, same retrieval, same 42 questions — only the answerer changes:

| answerer | floor | yoke | lift |
|---|---|---|---|
| gemma-4-e4b | 20/42 | 28/42 | **×1.40** |
| gemma-4-26b-a4b-qat | 21/42 | 21/42 | ×1.00 |
| ornith-1.0-35b-mlx | 19/42 | 24/42 | ×1.26 |

Two things this table proves. The floor is flat (~50%) across a 9× parameter range — these are
user-specific preferences, so no amount of world knowledge answers them without the memory. And a
bigger reader is not a better one: the 26b MoE (4B active) scores the same WITH yoke's context as
without it (answers parse fine — it genuinely ignores the memory), and the 35b reasoner uses the
context but worse than the 4B dense model does. Any headline lift must name its answering model;
comparing lifts across papers without that is comparing readers, not memories.

A frontier reader makes it worse, and the mechanism is the metric's own shape. `gpt-5-mini` over the
same two users: floor 24/42, yoke 25/42 — **lift ×1.04**, against the 4B model's ×1.40. It is not
that the strong reader reads the memory badly; it is that it does not NEED it. On u2 the 4B model
gains +7 from the memory (10 → 17) and gpt-5-mini gains +2 (14 → 16): four-option multiple choice
lets a capable model reason out the most plausible option unaided, so the floor rises and the
memory's marginal contribution shrinks. **Lift on an MCQ benchmark rewards a weak answerer.** Two
consequences: never quote a lift without its reader, and treat any cross-system lift comparison
(including ours against TencentDB's ×1.58) as unfounded unless both sides publish the reader AND
how the floor was scored — this harness itself deflated the floor to 0% until `runner.py:215` was
read.

Per-user spread swamps reader choice. The same yoke, same config, measured per user: ×1.70 (u3,
floor 10/28) down to ×0.93 (u4, floor 14/26 vs yoke 13/26 — the memory arm below the floor). Pooled
lift moved ×1.40 (2 users, n=42) → ×1.50 (3, n=70) → ×1.32 (4, n=96) as users were added. A lift
quoted without its user sample is noise wearing a decimal point.

### `yoke relate`: the 26b stalls, the fast model finds no supersedes

`google/gemma-4-26b-a4b-qat` never returned on a relate group (two 300s timeouts on a ~1KB prompt;
the endpoint answered a trivial call in 0.9s at the same moment — a reasoning stall, not a network
event; the request sets no max_tokens). `gemma-4-e4b` completes the run but files nearly everything
as `relates_to`: u1 got 2 supersedes edges, u2 got 0, so chain expansion over supersedes had
nothing to expand. Also: relate prints NOTHING on success until the final summary — a silent
20-minute run is healthy, check the relations table before killing it (a kill mid-run is safe:
commits are per-group and the gate refuses duplicates on resume).

### Against the other memory systems in this harness (the comparison that holds)

A lift ratio against a number from someone else's rig cannot be checked. The providers already in
this harness can: same corpus, same 42 questions, same answering model (`gemma-4-e4b`), one variable.

| provider | injected context | correct | correct per 1k tokens |
|---|---|---|---|
| `vanilla` (no memory) | 0 | 20/42 (47.6%) | — |
| **`yoke`** | **1,191 tok** | 28/42 (66.7%) | **23.5** |
| `bm25` | 5,123 tok | 26/42 (61.9%) | 5.1 |
| `qdrant` (dense + sparse, top-50) | 22,755 tok | **30/42 (71.4%)** | 1.3 |

State both halves. `qdrant` is the most accurate thing measured here — 4.7 points above yoke — and
it spends 19× the context to get there, which on this dataset is most of a small model's window
for one question. Efficiency differs by multiples; accuracy differs by points.

Two operational notes for repeating this:

- **`qdrant` needs `OMB_TIMEOUT` far above the default.** Its 22.8k-token injection does not finish
  inside 180s through a local 4B model, and the run dies as `APITimeoutError` — a rival losing on
  our timeout is not a measurement. 900s was enough.
- **`mem0` would not run locally**, and it is absent above for that reason rather than any result.
  Its provider here is built for cloud Gemini; pointing it at an OpenAI-compatible local endpoint
  needs `response_format` translated (LM Studio accepts only `json_schema` or `text`, mem0 sends
  `json_object`), and past that it fails inside its own pipeline (`'int' object has no attribute
  'replace'`) plus a SQLite cross-thread violation in its history store. Two fixes in, still no
  run; recorded here so the next attempt starts from the third problem rather than the first.

## Running

```bash
U=<user_id from above>
uv run amb run --dataset personamem --split 32k --llm openai --unit $U -m vanilla -n vanilla
uv run amb run --dataset personamem --split 32k --llm openai --unit $U -m bm25    -n bm25
uv run amb run --dataset personamem --split 32k --llm openai --unit $U -m yoke    -n yoke
```

Run the arms one at a time. Two runs against one local endpoint reproduce the concurrency stall above.

**One model answering and judging its own answers is weaker than a strong external judge**, and its
absolute accuracy should not be quoted as a PersonaMem score. What it supports is the comparison:
all three arms use the same answerer and the same judge, so the differences between them are real
even when the level is not.

## Cost and speed

`concurrency = 1`. One sqlite file with one shelled-out writer per call is a deliberate simplification
— concurrent writers on one DB is a different experiment than the one being run. Expect ingest to
dominate wall clock. If it becomes the blocker, the fix is per-user databases in `prepare()` (the
harness passes `unit_ids` for exactly this), not raising the concurrency on a shared file.

## Making it a fair test

**The default ontology has to be extended, or the run measures a vocabulary mismatch.** The seed
types (`fact`, `decision`, `term`, `resource`) are shaped for team and project knowledge. Measured on
one PersonaMem document (39k characters of conversation about reading habits): with the seed ontology
the extractor returned `[]` — asked for "durable work knowledge", it correctly found none — and
adding a single `preference` type took the same document to two records with no code change. The
extractor builds its type menu from the ontology, so this is data, not a patch:

```bash
cat > preference.json <<'JSON'
{ "name": "preference", "kind": "entity",
  "attrs": { "statement": { "type": "string", "required": true },
             "subject":   { "type": "string" } } }
JSON
export YOKE_BENCH_TYPES=$PWD/preference.json   # the provider seeds this in prepare()
```

**Ingest only the units you will query.** `--unit` does not reach documents on PersonaMem (see the
traps above), so all 195 arrive at the provider while 19 questions from one user are what gets asked.
`YOKE_BENCH_ONLY_USERS=<user_id>` skips the rest: measured 148s for 4 documents against roughly six
hours for 195, and it cannot change a score because retrieval is namespace-scoped — another user's
documents are unreachable for this user's queries. (The harness's own "ms/doc" line divides by all
195, so it reads 760ms/doc when the real cost was 37s per document actually ingested.)

## What the first run said, and why most of it was the harness

This section used to argue that a low score here was about domain fit — that PersonaMem rewards
recall while yoke's prompt is tuned for precision, so the benchmark was measuring the wrong thing.
That argument was mostly wrong, and the way it was wrong is worth keeping.

The first numbers were yoke 26.3% against bm25 42.1% on one unit (19 queries). Two measurements
moved them, neither of which touched what yoke stores:

**Chunking the source.** A model handed a 39k-character document summarises it: three records, two
kilobytes of output, nothing dropped downstream. The same model over the same material in 6k pieces
proposed thirteen. Across the unit, 9 records became 34.

**Fixing the answer path.** The harness's MCQ schema put `reasoning` before `choice`, and a token cap
truncates the JSON mid-string, so `json.loads` rejected a response whose chosen letter was already
complete. On every arm, 4 to 6 of 19 answers were discarded that way. Emitting `choice` first and
salvaging complete fields out of truncated JSON recovered them.

With both, on the same 19 queries and the same answering model:

| arm | accuracy | median context tokens | gold-word coverage |
| --- | --- | --- | --- |
| yoke (34 records) | 52.6% | **522** | 0.28 |
| yoke (9 records) | 42.1% | 349 | — |
| bm25 | 52.6% | 5,178 | 0.73 |

So yoke reaches bm25's accuracy on a tenth of the context, holding a quarter of the answer's
vocabulary. Two things follow that are easy to get backwards:

- **Coverage did not predict correctness.** Within yoke, queries answered right averaged 0.28 and
  queries answered wrong averaged 0.29. Feeding the model more of the source is not what was
  converting into accuracy — bm25 carried 2.6x the gold vocabulary for the same score.
- **19 queries cannot separate these arms.** The two yoke variants scored 5/19 each before the fix
  and agreed on only one of the five (McNemar p=1.0). Any conclusion at this n is provisional; run
  several units with `--unit a,b,c`.

What survives of the original argument is narrow: yoke files decisions and changes ("stopped
listening to book podcasts"), and some gold answers presuppose an interest it recorded as dropped.
That is a real bias in the extraction prompt. It was not worth 26 points.
