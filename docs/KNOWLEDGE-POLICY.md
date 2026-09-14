# yoke — Knowledge Policy

Knowledge management is strict. Strictness always breaks down on the write path, so **all knowledge enters through exactly one commit path in the core.** There is no route for an adapter to write to storage directly (this dovetails with ARCHITECTURE invariant 1).

One-line summary: **free to enter, signed to stay, loud to leave.**

A record is not made trustworthy by a gatekeeper reading it on the way in — no gatekeeper scales to
the write rate of a team of agents, and a queue nobody drains is a store nobody reads. It is made
trustworthy by what holds it accountable after it is in: every record carries a signature, expires
unless a person re-confirms it, and can only leave with a reason that is broadcast to everyone who
was handed it. Entry is cheap; **persistence is what a human grants.**

## Hard rules — reject on violation

1. **Ontology validation**: an entity/relation type not in the schema is rejected. The ontology changes only through an explicit migration.
2. **Provenance required**: who/what (person, agent, or document) and when — reject if missing. Knowledge without provenance isn't knowledge, it's rumor. The actor on a record is its signature: whatever enters, someone answers for, and under `serve --auth` the actor is bound to the credential, so a signature cannot be chosen freely.
3. **Immutable history**: no overwrites, no physical deletes — the storage port exposes no delete
   API at all (a conformance case bans the method names). An edit is a new version; retirement is
   `deprecated`, a status, so nothing resembling deletion exists to tombstone. You must always be
   able to reconstruct the state of knowledge at any point in time.

## Soft rules — let it through, and hold it accountable

4. **Status lifecycle**: every record is born `verified` — filing under a signed actor IS the entry
   bar — and then either stays confirmed, ages to `stale`, or is retired to `deprecated`.
   `verify` is the act of **re-confirmation**: a person saying "this is still true", which refreshes
   `last_confirmed` (and revives a retired record, deliberately — un-retiring is the same explicit
   act). `deprecate` is retirement, and it carries a **reason** in the retiring person's words.
   There is no approval step, because the accountability runs the other way: the question a reader
   asks is never "who let this in" but "who signed it, when was it last confirmed, and has anyone
   challenged it" — and every one of those has an answer on the record itself.
5. **Injection filter**: context injection injects only `verified` — records standing inside their
   freshness window. `stale` and `deprecated` are **never** injected, and there is deliberately no
   include-stale option anywhere: a record past its TTL is exactly the one an agent must not repeat;
   the re-confirmation queue exists so a person revives it instead. This — not the write path — is
   where strictness is enforced.
6. **Duplicates and contradictions are recorded, not deleted**:
   - On commit, look up similar entities → if it's a duplicate, propose a merge (no automatic merging).
   - If it contradicts existing knowledge, keep both and link them with a `conflicts_with` relation —
     injection then serves **both sides marked as disputed**, which is the correction arriving where
     the readers are.
   - Never auto-resolve a contradiction. The existence of the contradiction is itself knowledge.
7. **Freshness**: a `last_confirmed` timestamp is required, and it is the lease. Knowledge is
   automatically demoted to `stale` once it exceeds its type's confirmation interval → and excluded
   from injection. The system assumes that knowledge, left alone, rots — which is also its answer to
   unattended noise: what nobody re-confirms, nobody keeps being told.
8. **Retraction is a broadcast, not a deletion**: retiring a record with `--reason` does not just
   stop it being served — the per-reader delivery ledger (`--unseen`, SPEC "Since, and unseen")
   carries the retirement, with its reason, to **every client that was previously handed the
   record**. A wrong record's damage window is the time until one person notices, not the time until
   everyone independently finds out.

## v1 implementation scope — all included

| Rule | form |
|---|---|
| Hard rules 1–3 | synchronous validation on the commit path |
| 4 lifecycle | a `status` field in the entity schema; `verified` at birth |
| 5 injection filter | a default filter (`verified`) in the query layer |
| 6 duplicate detection | sqlite-vec embedding similarity (inside SQLite, no separate vector DB) |
| 6 contradiction recording | the reserved relation type `conflicts_with` |
| 7 stale demotion | **decided at read time**, not by a batch job — computed at query time from `last_confirmed` + a per-ontology TTL. No daemon or cron needed |
| 8 retraction broadcast | `deprecate --reason` + the `--unseen` delivery ledger |
| re-confirmation workflow | CLI: `yoke review` (the stale queue, most-consumed first) / `yoke verify <id...>` (re-confirm, batch supported) |

<!-- ceiling: stale is computed at read time. If tens of thousands of entries plus query latency become a problem, switch to batch demotion -->

## Why the gate was removed

Decided 2026-09-11, after surveying how OpenClaw, Hermes Agent, mem0, Zep and AiKA capture
knowledge: every capture system in production is opt-out — post-hoc correction, not pre-use
approval. The approval queue was this product's adoption cliff. A corpus stuck in draft is a product
that looks dead, and a confirmation prompt is friction at exactly the moment capture must be free.

What made the flip safe here is machinery those systems do not have: signed provenance bound to the
credential, TTL expiry that composts what nobody re-confirms, disputes served marked, and the
`--unseen` ledger turning a retirement into a recall notice that chases every delivery. **Approval on
entry was protecting readers with the weakest of the five mechanisms.**

## The trade this policy makes

Live-at-birth accepts that a wrong record can be served before a person sees it. The mechanisms
above bound that exposure — attribution (someone signed it), freshness (it expires unless confirmed),
dispute (a counter-claim is served beside it), retraction (the correction chases the delivery) — and
what the policy buys with it is the property the other direction cannot have: **the corpus is never
empty and never stalls on an approval queue.** A gate on entry protects readers from bad records by
also protecting them from all records; this policy protects them record by record, after the fact,
with names attached.
