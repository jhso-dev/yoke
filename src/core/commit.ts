// commit gate — the only write path into storage (KNOWLEDGE-POLICY hard rules 1–3).
// The pipeline order is fixed. Time is injected — never call new Date() in core (SPEC: inject the clock).
// Stages 3 & 4 (duplicate/conflict, v0.4) run only when an embedder is injected and embedding
// succeeds. An embedding failure never blocks a commit (without a vector, duplicate detection is
// skipped to avoid false positives). No auto-merge, no auto-reject.
// Every entity commit also records its authorship as an authored_by edge (stage 4b) so that
// provenance is reachable by graph traversal — see the comment at that stage.

import { ulid } from "ulid";
import type { StoragePort } from "../ports/storage.js";
import type { Embedder } from "./embedding.js";
import { serializeText } from "./embedding.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import { validateInput } from "./ontology.js";
import type {
  Entity,
  EntityInput,
  Provenance,
  Relation,
  RelationInput,
} from "./types.js";

// ceiling: start with a single threshold constant (0.85). Move to per-type thresholds if precision problems show up in practice.
const DUP_THRESHOLD = 0.85;

export class CommitRejected extends Error {
  constructor(
    readonly reason: "ontology" | "provenance",
    message: string,
  ) {
    super(message);
    this.name = "CommitRejected";
  }
}

export interface CommitResult {
  entity: Entity | Relation;
  /** Existing entities with similarity >= threshold (no auto-merge — the caller decides). */
  duplicates: Entity[];
  /** Auto-created conflicts_with relations (on decision conflict). Both sides preserved, no auto-resolution. */
  conflicts?: Relation[];
  /** Why duplicates is empty: an embedding comparison ran vs. detection was skipped entirely.
   * Without a vector (no embedder, embedding failed, or similar unsupported), treating every
   * candidate as a duplicate yields too many false positives, so detection is skipped. */
  duplicateDetection: "embedding" | "skipped";
  /** True when this commit found the record already there and stored nothing. Only relations reach
   * this today (see the identity note in `commit`), and a caller that says "linked" either way is
   * telling someone they did something they did not. */
  existed?: boolean;
}

interface CommitOpts {
  /** When set, a re-commit = current latest version + 1 (append-only, history preserved). */
  existingId?: string;
  /** Injected embedder. Without it, duplicate/conflict detection is SKIPPED — deliberately not an
   * FTS approximation (SPEC "Stage 3 has no FTS fallback"); only retrieval falls back to keywords. */
  embedder?: Embedder;
  /** Tenant namespace (PLAN-V2 10.1). The gate assigns it to the stored row; default = shared ns. */
  ns?: string | null;
}

/** Whether actor/origin/occurred_at are all non-empty strings. */
function provenanceOk(p: Provenance): boolean {
  return (
    typeof p.actor === "string" &&
    p.actor.length > 0 &&
    typeof p.origin === "string" &&
    p.origin.length > 0 &&
    typeof p.occurred_at === "string" &&
    p.occurred_at.length > 0
  );
}

/** Cosine similarity. Handles unnormalized vectors too (provider-independent scale). */
function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * The knowledge-ingest gate. Validates an EntityInput/RelationInput, assigns governed fields, then stores it.
 * @param now ISO 8601. Assigned as last_confirmed (core does not create time).
 */
export async function commit(
  port: StoragePort,
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
  prov: Provenance,
  now: string,
  opts?: CommitOpts,
): Promise<CommitResult> {
  // (1) Ontology validation.
  const v = validateInput(ontology, input);
  if (!v.ok) throw new CommitRejected("ontology", v.reason);

  // (2) Validate required provenance fields.
  if (!provenanceOk(prov))
    throw new CommitRejected(
      "provenance",
      "provenance requires non-empty actor, origin, occurred_at",
    );

  const existingId = opts?.existingId;
  const isRelation = "from" in input;

  // (3) Look up similar entities → duplicate candidates. Relations are not subject to this.
  let duplicates: Entity[] = [];
  let embedding: Float32Array | null = null;
  let duplicateDetection: CommitResult["duplicateDetection"] = "skipped";
  if (!isRelation && opts?.embedder) {
    const text = serializeText(input.type, JSON.stringify(input.attributes));
    embedding = await opts.embedder(text);
    if (embedding && port.similar) {
      const candidates = await port.similar(embedding, 5);
      duplicates = candidates.filter(
        (c) =>
          c.id !== existingId &&
          c.embedding !== undefined &&
          cosine(embedding as Float32Array, c.embedding) >= DUP_THRESHOLD,
      );
      duplicateDetection = "embedding";
    }
    // embedding null (fallback) or similar unsupported → stays "skipped" (detection skipped, empty array).
  }

  // (5) Assign id/version/status/last_confirmed, then store. (This is stage 5 in the SPEC order,
  // but stage 4's conflicts_with references the new entity id, so we store first.)
  const prev = existingId ? await port.getEntity(existingId) : null;
  const ns = normalizeNs(opts?.ns);
  const governed = {
    id: existingId ?? ulid(),
    status: "draft" as const,
    version: prev ? prev.version + 1 : 1,
    last_confirmed: now,
    provenance: prov,
    // Include ns only when set — the default namespace leaves the field absent (opaque parity).
    ...(ns !== null ? { ns } : {}),
  };

  if (isRelation) {
    const rel = input as RelationInput;
    // A relation's identity is (type, from, to) in a namespace — nothing else distinguishes one edge
    // from the same edge. Without this, pressing Link twice stored two rows with different ids, the
    // same actor and the same instant: the entity screen listed the link three times, the graph drew
    // three arrows over each other, and a collaboration counted one attached record as three.
    //
    // ceiling: dedup ignores `attributes`, because no seeded relation type declares any. A relation
    // that carried them would need the versioning entities get through `existingId`, and there is no
    // way to name an existing edge today — declare that before giving a relation attributes.
    // A symmetric relation means the same thing read either way (see `symmetric` in the ontology), so
    // the edge already exists whichever end it was recorded from — otherwise "A relates_to B" and "B
    // relates_to A" are one claim in two rows, which is the duplicate this check exists to stop.
    const symmetric =
      ontology.find((d) => d.kind === "relation" && d.name === rel.type)
        ?.symmetric === true;
    const already = (
      await port.neighbors(rel.from, rel.type, symmetric ? undefined : "out")
    ).find(
      (r) =>
        (r.ns ?? null) === ns &&
        (symmetric
          ? (r.from === rel.from && r.to === rel.to) ||
            (r.from === rel.to && r.to === rel.from)
          : r.from === rel.from && r.to === rel.to),
    );
    if (already)
      return {
        entity: already,
        duplicates: [],
        duplicateDetection: "skipped",
        existed: true,
      };
    const relation: Relation = { ...rel, ...governed };
    await port.putRelation(relation);
    return { entity: relation, duplicates: [], duplicateDetection: "skipped" };
  }

  const entity: Entity = { ...input, ...governed };
  if (embedding) entity.embedding = embedding;
  await port.putEntity(entity);

  // (4) Conflict detection — a decision-only heuristic. Among similar (duplicate-candidate)
  // decisions, a differing conclusion creates a conflicts_with. The only input to the judgment is
  // the conclusion text (the v1 ontology has no subject). Both sides preserved, no auto-resolution.
  // Relations must also pass the gate, so we reuse commit internally (relations skip stages 3 & 4,
  // so there is no infinite recursion).
  const conflicts: Relation[] = [];
  if (input.type === "decision") {
    const conclusion = String(input.attributes.conclusion ?? "");
    for (const dup of duplicates) {
      if (dup.type !== "decision") continue;
      if (String(dup.attributes.conclusion ?? "") === conclusion) continue;
      const rel = await commit(
        port,
        ontology,
        { type: "conflicts_with", attributes: {}, from: entity.id, to: dup.id },
        prov,
        now,
        { ns },
      );
      conflicts.push(rel.entity as Relation);
    }
  }

  // (4b) Authorship as a graph edge. provenance.actor is a stored field, so a graph walk cannot see
  // it — which is why persona used to need a listByActor lookup outside the port. Mirroring
  // authorship as an authored_by relation makes "knowledge from this person" the same one-hop walk
  // as "knowledge in this collaboration": one mechanism, and it works on every conformant backend.
  // Entities only (the inner call commits a relation, which returns above — no recursion), skipping
  // self-authorship, and idempotent per (entity, actor) so re-commits never pile up edges.
  // Skipped when the ontology in force does not declare authored_by: a tenant schema that never
  // registered the type has not opted into an authorship graph (persona there stays empty), and a
  // derived edge must never be the reason the caller's own commit fails.
  if (
    prov.actor !== entity.id &&
    ontology.some((t) => t.name === "authored_by")
  ) {
    const authored = await port.neighbors(entity.id, "authored_by", "out");
    if (!authored.some((r) => r.to === prov.actor))
      await commit(
        port,
        ontology,
        {
          type: "authored_by",
          attributes: {},
          from: entity.id,
          to: prov.actor,
        },
        prov,
        now,
        { ns },
      );
  }

  return {
    entity,
    duplicates,
    duplicateDetection,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}
