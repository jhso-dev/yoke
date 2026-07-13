# yoke — Knowledge Policy

Knowledge management is strict. Strictness always breaks down on the write path, so **all knowledge enters through exactly one commit path in the core.** There is no route for an adapter to write to storage directly (this dovetails with ARCHITECTURE invariant 1).

One-line summary: **lenient on write, strict on injection.**

## Hard rules — reject on violation

1. **Ontology validation**: an entity/relation type not in the schema is rejected. The ontology changes only through an explicit migration.
2. **Provenance required**: who/what (person, agent, or document) and when — reject if missing. Knowledge without provenance isn't knowledge, it's rumor.
3. **Immutable history**: no overwrites, no physical deletes. An edit is a new version; a delete is a tombstone. You must always be able to reconstruct the state of knowledge at any point in time.

## Soft rules — let it through, but quarantine by grade

4. **Status lifecycle**: every piece of knowledge is `draft → verified → stale | deprecated`. New entries default to `draft`.
5. **Injection filter**: context injection injects only `verified` by default. `draft`/`stale` only on explicit request, and with a status label attached. This — not the write path — is where strictness is actually enforced.
6. **Duplicates and contradictions are recorded, not deleted**:
   - On commit, look up similar entities → if it's a duplicate, propose a merge (no automatic merging).
   - If it contradicts existing knowledge, keep both and link them with a `conflicts_with` relation.
   - Never auto-resolve a contradiction. The existence of the contradiction is itself knowledge.
7. **Freshness**: a `last_confirmed` timestamp is required. Even verified knowledge is automatically demoted to `stale` once it exceeds its confirmation interval → and excluded from injection. The system assumes that knowledge, left alone, rots.

## v1 implementation scope — all included

| Rule | v1 form |
|---|---|
| Hard rules 1–3 | synchronous validation on the commit path |
| 4 lifecycle | a `status` field in the entity schema |
| 5 injection filter | a default filter (`verified`) in the query layer |
| 6 duplicate detection | sqlite-vec embedding similarity (inside SQLite, no separate vector DB) |
| 6 contradiction recording | the reserved relation type `conflicts_with` |
| 7 stale demotion | **decided at read time**, not by a batch job — computed at query time from `last_confirmed` + a per-ontology TTL. No daemon or cron needed |
| promotion workflow | CLI: `yoke review` (list drafts) / `yoke verify <id>` (promote, batch supported). The same command refreshes `last_confirmed` |

<!-- ponytail: stale is computed at read time. If tens of thousands of entries plus query latency become a problem, switch to batch demotion -->

## Cold-start trade-off

Early on, everything is draft, so there's nothing to inject. The remedy is to make **promotion cheap** (`yoke review` → batch verify), not to loosen the injection default. Loosen the default and no one ever tightens it again.
