# yoke — what breaks at scale, measured

Measured 2026-08-02 on one machine (darwin, node 22, better-sqlite3, WAL). Synthetic corpora of
10k / 100k / 1M / 10M `fact` entities and, separately, 3M relations over the 1M corpus. Status mix
70% verified / 20% draft / 10% deprecated; `last_confirmed` spread over Jan–Aug 2026 against a
`fact` TTL of 180 days, so roughly a sixth of the corpus is `stale`. Numbers are medians of 3–5
runs. Every measurement drove the **shipped** `SqliteStorage` and the **shipped** `inject()` —
nothing was reimplemented for the benchmark, so a bad number here was a bad number in production.

**Reproducing this** (corrected 2026-08-05): the fixtures are not checked in — a 4 GB database is not
something to commit — but the seeder now is, because "the numbers and the queries are quoted below" was
not the same as being able to re-run them:

```
npm run build
node scripts/seed-scale-corpus.mjs ./big1m.db 1000000 3000000
```

That claim held for a year and then did not. The generator lived in a scratch directory, which made
every number here a measurement in provenance and a claim in practice — the same gap the demo corpus
had until v5.5 promoted it into `scripts/`, and it surfaced the same way: someone went to delete the
scratch files. Promoting it also fixed a real defect in it. The scratch copy carried its own
`CREATE TABLE` block, and that copy had drifted: **no indexes**. Every table below that names an index
as the fix was measured against a database the scratch seeder built without any, which happens to be
the honest "before" — but a later run of the same script would have silently measured the same
unindexed shape and called it "after". The committed version takes its schema from `SqliteStorage.init()`
so it cannot drift again.

The seeder bypasses the commit gate deliberately (a million records through `commit` is hours, and the
point is to load the READ paths). Consequence worth knowing before reusing it: no `authored_by` edges,
so it cannot measure anything that walks authorship.

## The headline

**Injection did not get slow first. It got wrong first, at every scale.**

| | 10k | 100k | 1M | 10M |
|---|---|---|---|---|
| `inject(query, {limit: 50})` | 0.2 ms | 1.0 ms | 10.3 ms | 131.6 ms |
| items an agent asked 50 for, and received | 29 | 29 | 29 | **29** |
| `listEntities({limit: 50})` (first page) | 0.1 ms | 0.1 ms | 0.1 ms | 0.1 ms |

Two independent defects produce that 29:

1. **The cap was applied before the filter.** `inject` passed `limit` into `search()` and then ran
   the verified/freshness filter in JS. 58.9% of the corpus was injectable, so a request for 50
   candidates yielded 29 survivors — while 589,285 injectable records sat unreturned.
2. **There was no relevance order at all.** FTS5 returns rowid order unless asked for `rank`, and
   rowid order here is insertion order. So the 50 were the 50 **oldest** matches. At 1M, the top 50
   by insertion order and the top 50 by bm25 shared **1 record out of 50**.

Keyset enumeration, by contrast, was flat at every scale — clause 3 of the enumeration contract
(`ORDER BY id` over a `WITHOUT ROWID` primary key) does what it was designed to do.

## Where the time went

At 10M entities, the same query under every combination (median ms):

| | storage order | relevance order (`ORDER BY rank`) |
|---|---|---|
| exact token, no filter | 0.0 | 3,239 |
| exact token, `status` pushed into SQL | 0.1 | 3,371 |
| starred token (as shipped), no filter | 106.9 | 5,089 |
| starred token, `status` pushed into SQL | 114.7 | 5,645 |

The query term was present in **all ten million** documents — deliberately the worst case. At 1%
selectivity (100k matches) relevance order cost 3.2 ms, and at 0.01% it cost 0.1 ms. **Selective
queries were never the problem.** Only terms so common that ranking on them is close to meaningless
are expensive, because bm25 has to score every match: FTS5 has no top-k early termination
(no block-max WAND), so there is no way to ask it for "the best 50" without paying for all of them.

### Missing indexes — the largest single number in this document

The schema had **no secondary indexes at all**. Consequences, and what one index each does:

| query | before | after | index |
|---|---|---|---|
| `listEntities({type})` on a type with no rows, 10M | **14,953 ms** | 3 ms | `entities(ns, type, id)` |
| `neighbors(id)`, 3M relations, ordinary node with 3 edges | **232 ms** | 0 ms | `relations(from_id)` + `relations(to_id)` |
| `neighbors(id)`, high-degree anchor (5,000 edges) | 231 ms | 5 ms | same |
| `inject({scope})` — a briefing, which walks neighbors | **567 ms** | 48 ms | same |
| `listRelations({type})` on a type with no rows, 3M | 202 ms | 0 ms | `relations(ns, type, id)` |

`neighbors` was the one that mattered most and the one hardest to see: it cost the same 232 ms for a
node with three edges as for one with five thousand, which is the signature of a full table scan.
Entity detail calls it once, the graph screen calls it per expansion, every briefing walks it.

SQLite resolves the `from_id = ? OR to_id = ?` disjunction with `MULTI-INDEX OR`, so two
single-column indexes are the right shape — a composite would not be used. On a `WITHOUT ROWID`
table every index implicitly carries the primary key, so `(from_id, id)` and `(from_id)` are
byte-identical (178,593,792 bytes each, checked) and the shorter spelling is the honest one.

**The price:** on the 1M-entity + 3M-relation database, 494 MB of index against 1.69 GB of data —
about 29% growth. That is the cost of the fix and it is not small. It buys 46× on `neighbors` and
5000× on a selective type filter.

### The crash

At 10M entities, `inject(query, {scope})` **killed the process** with a heap out-of-memory, in
`Statement::JS_all` → `RowBuilder::GetRowJS`. The scope-with-query branch called
`port.search({text, ns})` with no limit, so it tried to build ten million row objects. At 1M the
same path took 3.6 s; at 10M there is no number, only a core dump. This was the flagship v4.0 path.

## Two things that were **not** problems

Recorded because the temptation is to fix them anyway:

- **The briefing's N+1 `getEntity` loop.** 300 sequential point reads over the 1M corpus: 2.1 ms
  total. `better-sqlite3` is synchronous, so the `await` in that loop is not a round trip. Batching
  it would add code and change nothing.
- **The `MAX(version)` correlated subquery** in every read query. It shows in the plan as
  `CORRELATED SCALAR SUBQUERY` but resolves as `SEARCH entities USING PRIMARY KEY (id=?)` — a
  primary-key seek per candidate row, which is what the `(id, version)` primary key is for.

## A negative result worth keeping

The adapter appends `*` to every query token, so `"system"` is issued as `"system"*`. Measured at
1M, that star was the entire cost of the capped path (9.9 ms starred vs 0.0 ms exact) — a starred
term forces FTS5 to materialize the whole matching doclist before returning a row, where an exact
term streams and stops at the cap.

**Adding an FTS5 prefix index (`prefix='2 3 4'`) did not help.** It grew the index from 173 MB to
305 MB (+76%) and moved the query from 9.9 ms to 10.3 ms. The cost is the doclist merge, not the
vocabulary lookup, so a prefix index has nothing to fix.

And the star is not removable anyway: it is what makes a query token match a stem carrying an
agglutinative suffix (searching `parseArgs` finds `parseArgs로`), which is a pinned conformance case.
Once results are ordered by relevance the star's cost is dominated by the ranking pass — 5,089 ms
starred vs 3,239 ms exact at the worst case, 36% rather than 100× — so the right call is to keep it
and record why, not to trade Korean matching for a fraction of a degenerate query.

## What the literature says about the shape of the fix

Surveyed 2026-08-02, and the finding was the opposite of the intuition that scale means vectors:

- **[BM25 Wins at Scale](https://arxiv.org/html/2607.26497)** (arXiv 2607.26497, 2026-07) varies
  corpus size across 28 nested tiers to 511,959 documents / 600M tokens. BM25 overtakes agentic
  file search at roughly 10M corpus tokens and leads by ~20 points at full scale (50.5% vs 30.7%).
  **Dense retrieval is consistently below both** (58.1% → 29.9%). Graph-based indexing becomes
  prohibitive to construct: LightRAG extrapolates to ~102B tokens, about four instance-years. The
  authors' recommendation is that "BM25 is the appropriate default" at enterprise scale.
- **Filtered ANN is not a solved problem.** yoke filters on `ns`, `status` and `type` on *every*
  read, which is precisely the hard case — see the 2026 benchmarks
  ([2507.21989](https://arxiv.org/html/2507.21989v3),
  [2509.07789](https://arxiv.org/html/2509.07789v1)) and
  [ACORN](https://dl.acm.org/doi/10.1145/3654923), whose approach is to ignore predicates at build
  time and traverse the induced subgraph at query time.
- **`sqlite-vec` is brute force**, which caps it in the low millions
  ([release notes](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)). The
  port's optional `similar?()` is therefore not a scale answer as it stands.

So the FTS-first design is the right one on current evidence. What was wrong was how it was being
called, not what it was calling.

## After the fixes (2026-08-03)

Same corpora, same shipped code, re-measured:

| | before | after |
|---|---|---|
| asked for 50 injectable records, received (10M) | 29 | **50**, all verified |
| asked for 50 injectable records, received (1M) | 29 | **50** |
| `inject({scope})` briefing, 1M + 3M relations | 567 ms | 74 ms |
| `inject(query, {scope})` at 10M | **heap crash** | 4.0 s, 50 items |
| `listEntities({type})` at 10M | 14,953 ms | 0.1 ms |
| `neighbors(id)` at 3M relations | 232 ms | 0.1 ms |

And the cost of relevance ordering, which is the trade this bought. `inject(query, {limit: 50})` at
10M, by how much of the corpus the query term matches:

| selectivity | matches | inject |
|---|---|---|
| 0.01% | 1,000 | 1.5 ms |
| 1% | 100,000 | 60 ms |
| ~7% | 714,000 | 288 ms |
| two-term AND | small intersection | 47 ms |
| 100% | 10,000,000 | **5.4 s** |

Roughly 0.5 µs per matched document scored, which is what O(matches) looks like. The broad end got
**slower** than before — 132 ms to 5.4 s — because the old path did not rank at all. That is not a
like-for-like regression (the old 132 ms returned the wrong 29 records), but it is a real number and
a real tail.

Two honest caveats on the table above:

- **These numbers are cache-sensitive.** The same 7% query measured 288 ms warm and ~2.5 s cold in a
  fresh process. The comparison that survives both is the *ratio* between ordering strategies, not
  any single figure.
- **The ordering improvement cannot be demonstrated on this corpus.** Every document contains the
  query term exactly once at near-identical length, so bm25 scores tie everywhere and FTS5 breaks
  ties by rowid — which means the results are still in insertion order even after the fix. That is
  correct behaviour for genuinely tied relevance, not a residual bug, and the reordering is proven
  instead by conformance case 6d on constructed data (a record *about* a term outranks one that
  merely mentions it among filler). A synthetic corpus with no relevance signal cannot show a
  relevance fix; saying so is more useful than a table implying otherwise.

## The decision left open: what to rank, and over what window

`ORDER BY rank` scores every match, which is where the 5.4 s comes from. A bounded alternative was
measured on the same 10M corpus — take the most recently indexed window and rank inside it:

| ordering, at 10M | term in 100% of docs | term in ~7% |
|---|---|---|
| `ORDER BY rank` (shipped) | 6,221 ms | 2,534 ms |
| `ORDER BY rowid DESC`, then bm25 over 150 rows | **162 ms** | **9 ms** |

38x to 272x cheaper, and still relevance-ordered — just relevance among recent matches rather than
among all matches. For a store whose knowledge has a TTL, whose briefings already order by
`last_confirmed`, and which withholds stale records anyway, preferring recent knowledge is arguably
the better prior rather than a compromise.

It is **not** shipped, for two reasons worth stating rather than deciding quietly:

1. It is a product-semantics choice — "the best matches" becomes "the best of the recent matches" —
   and that belongs to whoever owns what injection means, not to a latency measurement.
2. The window would be selected by FTS5 `rowid`, which is insert order, which changes when `verify`
   rewrites a row. That happens to make it a decent recency signal for a governed store, but it is
   an implementation detail of the index standing in for a semantic field, and `last_confirmed`
   cannot serve instead without sorting every match — the cost we are trying to avoid.

The principled version of the same idea is selectivity-aware: probe term frequency with an
`fts5vocab` table (an indexed lookup per term), rank globally when the match set is small enough to
afford it, and fall back to a bounded window when it is not. That is more code and one more
threshold, and it is worth building on a real corpus that has hit the tail — not on this synthetic
one, where the expensive case is a term in literally every document.

## The ceiling that remains

Ranking a query whose terms match a large fraction of the corpus costs O(matches): ~3.2 s at 10M
for a term in every document. There is no fix inside FTS5, because top-k early termination is an
index feature it does not have. The upgrade path, if a corpus ever needs it, is an engine with
block-max WAND (Tantivy, Lucene) behind the same port — which is exactly the shape the port exists
to allow, and a decision to take on evidence rather than in advance.

Not measured, and worth measuring before anyone relies on it: whether the *injectable* subset
(verified, fresh, in-namespace) is small enough in a real governed corpus to be worth indexing
separately. In this synthetic mix it was 58.9%, which is a 1.7× win and not worth the complexity.
A real corpus with years of superseded knowledge could be very different.
