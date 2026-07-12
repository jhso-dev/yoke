// yoke 온톨로지 — 타입 정의 + 입력 검증 + 시드.
// 검증기는 4종 AttrSpec만 다루는 수동 구현. 스키마 라이브러리 도입 금지.
// ponytail: 타입 4종 수동 검증. 중첩 객체 스키마가 필요해지면 zod로.

import type { EntityInput, RelationInput } from "./types.js";

export type AttrSpec = {
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
};

export type TypeDef = {
  name: string;
  kind: "entity" | "relation";
  attrs: Record<string, AttrSpec>;
  /** 신선도 판정용 TTL (일). 미지정 = 무제한. 2.1 lifecycle에서 사용. */
  ttl_days?: number;
};

/** AttrSpec.type과 실제 값이 맞는지. */
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
