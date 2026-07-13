# yoke — Enterprise (v3.x design)

The design direction for multi-tenancy, auth, RBAC, and distribution. When work
starts (v3.0), this document is promoted to a detailed spec. What's written here is
the set of **backward-compatibility constraints to uphold from v0.1 on** and the
directional decisions.

## Constraints to uphold from v0.1 on (the reason this document exists now)

1. **IDs are opaque strings** — so a tenant-namespace prefix (`tenant/ulid`) can be
   added later. No code that parses an ID to extract meaning.
2. **All reads/writes pass through the core path** — auth/RBAC plug into this path as
   middleware. A single adapter side door becomes a security hole in v3.
3. **Append-only history** — the basis for the audit log and PITR. No
   physical-delete code (tombstone instead).
4. **provenance.actor references a person entity** — this is what later connects to
   the auth subject.

## Multi-tenancy (v3.0)

- Isolation unit: the namespace. A tenant = a top-level namespace.
- Approach: start with logical isolation (a single DB + a namespace column); switch
  to physical isolation (a per-tenant DB file) behind the storage port when a
  regulated customer requires it — with no interface change.
- Ontology: a per-tenant ontology + inheritance from the org-shared ontology (the
  shared one is the base; the tenant extends it).

## Auth / RBAC (v3.0)

- Authentication: OIDC/SSO (the enterprise standard) + API tokens (for agents and
  CI). We don't store passwords ourselves.
- Authorization axes: namespace × ontology type × action (read / write / **verify**).
  **The verify permission *is* the knowledge-governance permission** — who can
  promote knowledge is the single most important axis in this product's permission
  model. We separate admin/write/verify.
- MCP connection: the token scope carries the three axes above. An agent is
  write-only by default (can only stage drafts, cannot verify) — enforcing the policy
  that a human owns the gate.

## Audit log (staged early, in v2.0)

- Targets: commit (with the accept/reject reason), verify/demotion, inject (who got
  what knowledge injected).
- Implementation: not a separate system, but a query view over the append-only
  history + provenance. Keep "what the knowledge was" (entity versions) and "who saw
  it when" (the inject log) stored separately.

## Distribution / HA (v3.5)

- Order: read replicas first — injection (reads) is the dominant share of traffic,
  and writes are low-frequency work that passes the gate, so a single writer holds up
  for a long time.
- Backup/PITR: append-only makes this fall out naturally from snapshot + history
  replay.
- Sharding: no design before measured limits are confirmed. We only note that
  per-tenant sharding is the natural boundary (namespace isolation is the
  precondition).

## What we don't do

- Build our own IdP, field-level encryption (until a customer requires it), or a
  cross-tenant knowledge-sharing marketplace (not the vision).
