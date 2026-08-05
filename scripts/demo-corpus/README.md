# The demo corpus

504 records of internal knowledge from one fictional IT company, in Korean with the English technical
vocabulary such a company actually uses. Loaded by `scripts/load-demo-corpus.mjs`.

It exists because the two things yoke is judged on cannot be judged on synthetic data:

- **Retrieval quality.** Every record here is a different incident with a different conclusion. A
  generator that varies words inside one sentence skeleton produces a corpus where every query matches
  everything, and the measurement that came out of one (`scripts/seed-dummy-it-company.mjs`) was
  **0 of 676** semantic pairs — a hybrid retriever built on it would have shown no gain (docs/RESEARCH.md).
- **The governance screens.** A review queue needs drafts, a stale queue needs records confirmed long
  enough ago that the *ontology's own TTL* expires them, and the conflicts screen needs pairs that
  genuinely disagree about the same question. All three are properties of a corpus, not of a fixture.

## Files

| | what | count |
| --- | --- | --- |
| `01-…` … `10-…` | one department each: 3 people, one `collaboration` anchor, 26 records, links | 10 |
| `a1-…` … `a6-…` | `aged` records and `conflicts` pairs over the existing roster | 6 |

## Shape

Departments:

```json
{
  "collaboration": { "id": "collab:<slug>", "title": "<what this department is working on now>" },
  "people": [{ "id": "person:<slug>", "name": "…", "role": "…", "team": "…" }],
  "records": [{
    "key": "<unique within this file>",
    "type": "fact" | "decision" | "term" | "resource",
    "author": "person:<slug>",
    "size": "line" | "short" | "para" | "half" | "a4",
    "state": "verified" | "draft" | "stale",
    "attributes": { }
  }],
  "links": [{ "type": "relates_to" | "supersedes" | "conflicts_with", "from": "<key>", "to": "<key>" }]
}
```

Aged and conflicts:

```json
{
  "aged": [{ "key": "…", "type": "fact" | "decision", "author": "person:<slug>",
             "collab": "collab:<slug>", "age_days": 200, "size": "…", "attributes": { } }],
  "conflicts": [{ "key": "…", "topic": "<what the disagreement is about>",
                  "a": { "type": "…", "author": "…", "collab": "…", "age_days": 0, "attributes": { } },
                  "b": { "…": "…" } }]
}
```

`attributes` follows the seed ontology (`seedOntology()`), so the loader needs no per-type knowledge:
`fact`/`term`/`resource` carry `title` + `statement` (`resource` adds `url`), and `decision` carries
`conclusion` + `rationale` + `rejected_alternatives` (a string array).

## What the loader does with each field, and why

- **`size`** is not stored. It is the authoring constraint that gives the corpus a real length
  distribution — one `a4` document of 2,500–4,000 characters per department down to ten one-liners of
  40–120. That spread is what caught the entity screen rendering a 2,809-character postmortem with 40
  line breaks as a single paragraph (v5.3).
- **`state: "stale"`** is not a stored status. `stale` is computed at read time from
  `last_confirmed + ttl_days`, so the loader confirms the record 330 days ago and lets the ontology's
  arithmetic decide. Same for `age_days`: `fact` expires at 180 days, `decision` at 365, and the
  distribution deliberately straddles both.
- **`author`** is who confirms the record, not just who wrote it. `verify` *replaces* provenance, so
  confirming a whole corpus as one steward erases every author and points the stale queue's owner
  routing — it reads `provenance.actor` — at that one person. This was learned by doing it wrong on a
  live corpus and repairing 213 records from their `authored_by` edges.
- **`supersedes`** deprecates its target, so the corpus contains real deprecated knowledge rather than
  a status set by hand.
- **`conflicts_with`** links two verified records and resolves neither. The contradiction is knowledge:
  yoke keeps both sides and does not decide.

## Regenerating or extending it

The records were written by agents, one department per agent, against a contract that pinned the
length distribution, the state distribution, and the link minimums per file. Two rules did the most
work and are worth keeping if you extend it:

1. **No template repetition.** If several records share a sentence skeleton with words swapped, the
   file is a failure — that is exactly the corpus retrieval metrics cannot see through.
2. **Concrete values everywhere** (`03:10 KST`, `p99 320ms`, `v2.14.1`, `payments-api`), and in aged
   records, values that would plausibly have *changed* since. A re-confirmation request is meaningless
   if there is nothing specific to re-check.

No real company, product or person names; no personal data.
