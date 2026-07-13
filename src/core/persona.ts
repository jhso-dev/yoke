// persona — person 스코프 질의 + SKILL.md 생성 (PLAN 6.1~6.2).
// persona는 저장물이 아니라 파생물(VISION): 매번 현재 verified 지식에서 생성한다.
// 흉내가 아니라 인용 — 출력은 인용 기반이어야 감사 가능하다.
// 시간은 주입받는다 (core에서 new Date() 금지).

import { citation } from "./inject.js";
import { effectiveStatus } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

/**
 * persona 질의에 필요한 저장소 능력만 담은 로컬 구조적 타입.
 * StoragePort(getEntity/neighbors) + 어댑터 확장(listByActor)의 교차 — core가 어댑터를
 * import하면 의존 방향 위반이므로 여기서 구조적 타이핑으로만 받는다(어댑터 import 금지).
 */
export interface PersonaPort {
  getEntity(id: string, version?: number): Promise<Entity | null>;
  neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<{ from: string; to: string }[]>;
  /** provenance.actor === actor인 최신 버전 entity (어댑터 확장 메서드). */
  listByActor(actor: string): Entity[];
}

export interface PersonaResult {
  decisions: Entity[];
  facts: Entity[];
}

/**
 * 특정 인물이 출처인 verified 지식을 수집한다.
 * 수집: (a) provenance.actor === personId 인 entity(listByActor, 최신 버전 actor 기준)
 *       + (b) authored_by relation으로 연결된 entity.
 * authored_by 의미 = "entity가 person에 의해 작성됨" → from:entity → to:person.
 * 따라서 person 기준 dir:'in'(to_id=personId) 이웃의 from이 대상 entity다.
 * 필터: effectiveStatus === 'verified'만 (inject와 동일 — 새 필터 로직 없음).
 * 분류: type==='decision' → decisions, 나머지 → facts.
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

/** personId를 파일/skill name에 안전한 형태로 (영숫자·-·_ 외 → -). */
export function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** attributes의 첫 string 값 (지식 요약용). 없으면 빈 문자열. */
function firstString(attrs: Record<string, unknown>): string {
  for (const v of Object.values(attrs)) {
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * personaQuery 결과를 SKILL.md 한 장으로 렌더한다 (파생물 — 재생성이 원칙).
 * 헤더에 생성 시각 + 소스 지식 버전을 남겨 감사 근거로 삼는다.
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
  out.push(`description: ${name}의 기록된 판단·지식 기반 persona`);
  out.push("---");
  out.push("");
  out.push(`# ${name} persona`);
  out.push("");
  out.push(`생성 시각: ${now}`);
  out.push(
    `소스 지식 (${sources.length}건): ${
      sources.map((e) => `${e.id}@v${e.version}`).join(", ") || "(없음)"
    }`,
  );
  out.push("");

  out.push("## 판단 원칙");
  out.push("");
  if (decisions.length === 0) out.push("(기록된 결정 없음)");
  else
    for (const d of decisions) out.push(`- ${String(d.attributes.rationale)}`);
  out.push("");

  out.push("## 결정 기록");
  out.push("");
  if (decisions.length === 0) out.push("(없음)");
  else
    for (const d of decisions) {
      out.push(`### ${String(d.attributes.conclusion)}`);
      out.push(`- 근거: ${String(d.attributes.rationale)}`);
      out.push(`- 출처: ${citation(d)}`);
      out.push("");
    }

  out.push("## 지식");
  out.push("");
  if (facts.length === 0) out.push("(없음)");
  else
    for (const f of facts)
      out.push(`- ${firstString(f.attributes)} — ${citation(f)}`);
  out.push("");

  out.push("## 지시");
  out.push("");
  out.push("인용 없는 답변 금지. 위 기록에 없으면 '기록 없음'이라고 답하라.");
  out.push(`${name}인 척 말하지 말고 기록을 인용하라.`);
  out.push("");

  return out.join("\n");
}
