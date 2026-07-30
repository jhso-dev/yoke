// yoke ontology — type definitions, input validation, and the seed set.
// The validator is a hand-rolled implementation covering only 4 AttrSpec kinds. No schema library.
// ponytail: 4 attribute kinds, validated by hand. Reach for zod if nested object schemas become necessary.

import type { EntityInput, RelationInput } from "./types.js";

export type AttrSpec = {
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
};

export type TypeDef = {
  name: string;
  kind: "entity" | "relation";
  attrs: Record<string, AttrSpec>;
  /** TTL (in days) for freshness. Omit = unlimited. Used by the 2.1 lifecycle. */
  ttl_days?: number;
  /**
   * Relation types only: this edge records WHO IS INVOLVED in something, not knowledge attached to it.
   *
   * An anchored briefing walks every relation on the anchor, so without this a collaboration briefing
   * hands an agent the roster (`works_on` → three person records) as though it were knowledge — and
   * under a limit the roster can crowd the knowledge out entirely.
   *
   * It is ontology DATA, not a name hardcoded in core, because orgs define their own equivalents
   * (assigned_to, member_of, reviews) — see the collaboration note below. A tenant that adds a
   * membership relation marks it here and gets the same behaviour, with no core change.
   */
  membership?: boolean;
};

/** Whether the actual value matches AttrSpec.type. */
function matchesType(spec: AttrSpec["type"], value: unknown): boolean {
  switch (spec) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

export function validateInput(
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
): { ok: true } | { ok: false; reason: string } {
  const def = ontology.find((t) => t.name === input.type);
  if (!def) return { ok: false, reason: `unknown type: ${input.type}` };

  const isRelation = "from" in input;
  if (def.kind === "relation" || isRelation) {
    const r = input as RelationInput;
    if (!r.from)
      return { ok: false, reason: "relation requires non-empty from" };
    if (!r.to) return { ok: false, reason: "relation requires non-empty to" };
  }

  for (const [key, spec] of Object.entries(def.attrs)) {
    const value = input.attributes[key];
    if (value === undefined || value === null) {
      if (spec.required)
        return { ok: false, reason: `missing required attribute: ${key}` };
      continue;
    }
    if (!matchesType(spec.type, value)) {
      return { ok: false, reason: `attribute ${key} must be ${spec.type}` };
    }
  }
  return { ok: true };
}

export function seedOntology(): TypeDef[] {
  return [
    { name: "person", kind: "entity", attrs: {} },
    { name: "fact", kind: "entity", attrs: {}, ttl_days: 180 },
    {
      name: "decision",
      kind: "entity",
      attrs: {
        conclusion: { type: "string", required: true },
        rationale: { type: "string", required: true },
        rejected_alternatives: { type: "string[]" },
      },
      ttl_days: 365,
    },
    { name: "term", kind: "entity", attrs: {} },
    { name: "resource", kind: "entity", attrs: {} },
    // One thing being worked on together, for as long as it lasts (v4.0 shared working context). Named
    // for what the definition always said — "a unit of collaborative work" — because a type name that
    // is a different word from its own definition is a name nobody can guess. It groups nothing in the
    // containment sense: people and records point AT it, so deprecating one leaves them all intact.
    // Orgs define their own equivalents in their ontology (initiative, experiment, …).
    {
      name: "collaboration",
      kind: "entity",
      attrs: {
        title: { type: "string", required: true },
        status: { type: "string" },
      },
    },
    { name: "authored_by", kind: "relation", attrs: {} },
    { name: "relates_to", kind: "relation", attrs: {} },
    { name: "supersedes", kind: "relation", attrs: {} },
    { name: "conflicts_with", kind: "relation", attrs: {} },
    // Links a person to a collaboration they participate in (v4.0). Membership, not knowledge: the
    // roster belongs on the collaboration screen, not in the briefing an agent is handed.
    { name: "works_on", kind: "relation", attrs: {}, membership: true },
  ];
}
