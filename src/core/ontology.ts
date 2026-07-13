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
    { name: "authored_by", kind: "relation", attrs: {} },
    { name: "relates_to", kind: "relation", attrs: {} },
    { name: "supersedes", kind: "relation", attrs: {} },
    { name: "conflicts_with", kind: "relation", attrs: {} },
  ];
}
