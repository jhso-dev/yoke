// persona — the person-anchored reading of an injection, rendered as a SKILL.md (PLAN 6.1–6.2).
// A persona is not stored but derived (VISION): regenerated each time from the current verified knowledge.
// Citation, not impersonation — the output must be citation-based to be auditable.
//
// Collection is deliberately NOT here: it is inject() anchored on the person entity, the same
// one-hop walk a workstream anchor uses (authorship is a graph edge — the commit gate mirrors
// provenance into authored_by). One mechanism, two named entry points. What persona adds is how
// that anchor is read: strictly. A workstream anchor prioritizes and lets org-wide knowledge in;
// a persona anchors on authored_by/'in' with no query and filters locally, because presenting
// knowledge a person did not author as their judgment would be impersonation.
// Time is injected (never call new Date() in core).

import type { StoragePort } from "../ports/storage.js";
import { citation, inject } from "./inject.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

export interface PersonaResult {
  decisions: Entity[];
  facts: Entity[];
}

/**
 * The persona entry point: an injection anchored on a person, read strictly.
 * authored_by means "entity authored by person" → from:entity → to:person, so the person's dir:'in'
 * neighbors are exactly the knowledge they authored — never what merely touches them (the workstream
 * they work on, the colleague who filed their person record).
 * @param query filters the person's OWN records (substring over attributes). It deliberately does
 *   not go through inject's query path: that unions in org-wide matches, which is right for a
 *   workstream and wrong for a persona.
 */
export async function personaQuery(
  port: StoragePort,
  ontology: TypeDef[],
  personId: string,
  now: string,
  opts?: { query?: string; ns?: string | null },
): Promise<PersonaResult> {
  const { items } = await inject(port, ontology, "", now, {
    scope: personId,
    scopeRel: "authored_by",
    scopeDir: "in",
    ns: opts?.ns,
  });
  const q = opts?.query?.toLowerCase();
  return classifyPersona(
    items
      .map((i) => i.entity)
      .filter(
        (e) =>
          q === undefined ||
          JSON.stringify(e.attributes).toLowerCase().includes(q),
      ),
  );
}

/** Splits injected knowledge into the persona shape. type==='decision' → decisions, rest → facts.
 * The verified/stale/draft filtering already happened in inject — no second filter lives here. */
export function classifyPersona(entities: Entity[]): PersonaResult {
  const decisions: Entity[] = [];
  const facts: Entity[] = [];
  for (const e of entities) (e.type === "decision" ? decisions : facts).push(e);
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
