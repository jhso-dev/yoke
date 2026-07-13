// persona — person-scoped query + SKILL.md generation (PLAN 6.1–6.2).
// A persona is not stored but derived (VISION): regenerated each time from the current verified knowledge.
// Citation, not impersonation — the output must be citation-based to be auditable.
// Time is injected (never call new Date() in core).

import { citation } from "./inject.js";
import { effectiveStatus } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

/**
 * A local structural type holding only the storage capabilities a persona query needs.
 * The intersection of StoragePort (getEntity/neighbors) and an adapter extension (listByActor) —
 * since core importing the adapter would violate the dependency direction, we accept it here by
 * structural typing only (no adapter import).
 */
export interface PersonaPort {
  getEntity(id: string, version?: number): Promise<Entity | null>;
  neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<{ from: string; to: string }[]>;
  /** Latest-version entities whose provenance.actor === actor (an adapter extension method). */
  listByActor(actor: string): Entity[];
}

export interface PersonaResult {
  decisions: Entity[];
  facts: Entity[];
}

/**
 * Collects the verified knowledge originating from a given person.
 * Collection: (a) entities where provenance.actor === personId (listByActor, matching the actor
 *             across history) plus (b) entities connected via an authored_by relation.
 * authored_by means "entity authored by person" → from:entity → to:person.
 * So the target entities are the `from` of person's dir:'in' (to_id=personId) neighbors.
 * Filter: effectiveStatus === 'verified' only (same as inject — no new filter logic).
 * Classification: type==='decision' → decisions, everything else → facts.
 */
export async function personaQuery(
  port: PersonaPort,
  ontology: TypeDef[],
  personId: string,
  now: string,
): Promise<PersonaResult> {
  const collected = new Map<string, Entity>();
  for (const e of port.listByActor(personId)) collected.set(e.id, e);
  for (const r of await port.neighbors(personId, "authored_by", "in")) {
    if (collected.has(r.from)) continue;
    const e = await port.getEntity(r.from);
    if (e) collected.set(e.id, e);
  }

  const decisions: Entity[] = [];
  const facts: Entity[] = [];
  for (const e of collected.values()) {
    if (effectiveStatus(e, ontology, now) !== "verified") continue;
    (e.type === "decision" ? decisions : facts).push(e);
  }
  return { decisions, facts };
}

/** Makes personId safe for use as a file/skill name (anything but alphanumerics, -, _ → -). */
export function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** The first string value in attributes (for a knowledge summary). Empty string if none. */
function firstString(attrs: Record<string, unknown>): string {
  for (const v of Object.values(attrs)) {
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Renders a personaQuery result into a single SKILL.md (a derivative — regeneration is the rule).
 * The header records the generation time and source-knowledge versions as the audit basis.
 */
export function renderPersonaSkill(
  person: Entity,
  result: PersonaResult,
  now: string,
): string {
  const { decisions, facts } = result;
  const name =
    typeof person.attributes.name === "string"
      ? person.attributes.name
      : person.id;
  const sources = [...decisions, ...facts];

  const out: string[] = [];
  out.push("---");
  out.push(`name: persona-${safeName(person.id)}`);
  out.push(
    `description: Persona grounded in ${name}'s recorded judgments and knowledge`,
  );
  out.push("---");
  out.push("");
  out.push(`# ${name} persona`);
  out.push("");
  out.push(`Generated: ${now}`);
  out.push(
    `Source knowledge (${sources.length}): ${
      sources.map((e) => `${e.id}@v${e.version}`).join(", ") || "(none)"
    }`,
  );
  out.push("");

  out.push("## Guiding principles");
  out.push("");
  if (decisions.length === 0) out.push("(no recorded decisions)");
  else
    for (const d of decisions) out.push(`- ${String(d.attributes.rationale)}`);
  out.push("");

  out.push("## Decision record");
  out.push("");
  if (decisions.length === 0) out.push("(none)");
  else
    for (const d of decisions) {
      out.push(`### ${String(d.attributes.conclusion)}`);
      out.push(`- Rationale: ${String(d.attributes.rationale)}`);
      out.push(`- Source: ${citation(d)}`);
      out.push("");
    }

  out.push("## Knowledge");
  out.push("");
  if (facts.length === 0) out.push("(none)");
  else
    for (const f of facts)
      out.push(`- ${firstString(f.attributes)} — ${citation(f)}`);
  out.push("");

  out.push("## Instructions");
  out.push("");
  out.push(
    'Do not answer without a citation. If it is not in the records above, answer "no record".',
  );
  out.push(`Do not speak as if you were ${name}; cite the records.`);
  out.push("");

  return out.join("\n");
}
