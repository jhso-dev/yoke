// commit 게이트 — 지식이 storage로 진입하는 유일한 쓰기 경로 (KNOWLEDGE-POLICY 하드 규칙 1~3).
// 파이프라인 순서 고정. 시간은 주입받는다 — core에서 new Date() 금지 (SPEC 시간 주입).
// v0.1은 1·2단계만. 3~4단계(중복·모순)는 v0.4 — duplicates는 항상 [] (시그니처만 고정).

import { ulid } from "ulid";
import type { StoragePort } from "../ports/storage.js";
import type { TypeDef } from "./ontology.js";
import { validateInput } from "./ontology.js";
import type {
  Entity,
  EntityInput,
  Provenance,
  Relation,
  RelationInput,
} from "./types.js";

export class CommitRejected extends Error {
  constructor(
    readonly reason: "ontology" | "provenance",
    message: string,
  ) {
    super(message);
    this.name = "CommitRejected";
  }
}

/** actor/origin/occurred_at이 전부 비어있지 않은 문자열인지. */
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

/**
 * 지식 적재 게이트. EntityInput/RelationInput을 검증·부여 후 저장한다.
 * @param now ISO 8601. last_confirmed로 부여 (core는 시간을 만들지 않는다).
 * @param opts.existingId 지정 시 재커밋 = 현재 최신 version + 1 (append-only, 이력 보존).
 */
export async function commit(
  port: StoragePort,
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
  prov: Provenance,
  now: string,
  opts?: { existingId?: string },
): Promise<{ entity: Entity | Relation; duplicates: Entity[] }> {
  // (1) 온톨로지 검증
  const v = validateInput(ontology, input);
  if (!v.ok) throw new CommitRejected("ontology", v.reason);

  // (2) provenance 필수 필드 검증
  if (!provenanceOk(prov))
    throw new CommitRejected(
      "provenance",
      "provenance requires non-empty actor, origin, occurred_at",
    );

  // (3~4) 중복·모순 — v0.4. 지금은 미구현, duplicates는 항상 [].

  // (5) id·version·status·last_confirmed 부여 후 저장
  const existingId = opts?.existingId;
  const prev = existingId ? await port.getEntity(existingId) : null;
  const governed = {
    id: existingId ?? ulid(),
    status: "draft" as const,
    version: prev ? prev.version + 1 : 1,
    last_confirmed: now,
    provenance: prov,
  };

  if ("from" in input) {
    const relation: Relation = { ...input, ...governed };
    await port.putRelation(relation);
    return { entity: relation, duplicates: [] };
  }
  const entity: Entity = { ...input, ...governed };
  await port.putEntity(entity);
  return { entity, duplicates: [] };
}
