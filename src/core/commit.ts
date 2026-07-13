// commit 게이트 — 지식이 storage로 진입하는 유일한 쓰기 경로 (KNOWLEDGE-POLICY 하드 규칙 1~3).
// 파이프라인 순서 고정. 시간은 주입받는다 — core에서 new Date() 금지 (SPEC 시간 주입).
// 3·4단계(중복·모순, v0.4): embedder가 주입되고 임베딩이 가능할 때만 동작. 임베딩 장애는
// commit을 막지 않는다 (FTS 폴백 시 중복 탐지 skip — 오탐 회피). 자동 병합·자동 거절 없음.

import { ulid } from "ulid";
import type { StoragePort } from "../ports/storage.js";
import type { Embedder } from "./embedding.js";
import { serializeText } from "./embedding.js";
import type { TypeDef } from "./ontology.js";
import { validateInput } from "./ontology.js";
import type {
  Entity,
  EntityInput,
  Provenance,
  Relation,
  RelationInput,
} from "./types.js";

// ponytail: 임계값 상수 하나(0.85)로 시작. 정밀도 문제가 실측되면 타입별 임계로.
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
  /** 유사도 ≥ 임계인 기존 entity (자동 병합 금지 — 호출자 판단). */
  duplicates: Entity[];
  /** 자동 생성된 conflicts_with relation (decision 모순 시). 양쪽 보존, 자동 해소 없음. */
  conflicts?: Relation[];
  /** duplicates가 비었을 때 그 근거: 임베딩 비교 결과 vs 탐지 자체를 skip.
   * FTS 폴백(embedder 미설정·임베딩 실패·similar 미지원)에서는 후보 전부를 중복으로
   * 취급하면 오탐이 많아 탐지를 skip한다. */
  duplicateDetection: "embedding" | "skipped";
}

interface CommitOpts {
  /** 지정 시 재커밋 = 현재 최신 version + 1 (append-only, 이력 보존). */
  existingId?: string;
  /** 주입받는 임베더. 없으면 중복·모순 탐지 skip (FTS 폴백). */
  embedder?: Embedder;
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

/** 코사인 유사도. 정규화 안 된 벡터도 처리 (provider별 스케일 무관). */
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
 * 지식 적재 게이트. EntityInput/RelationInput을 검증·부여 후 저장한다.
 * @param now ISO 8601. last_confirmed로 부여 (core는 시간을 만들지 않는다).
 */
export async function commit(
  port: StoragePort,
  ontology: TypeDef[],
  input: EntityInput | RelationInput,
  prov: Provenance,
  now: string,
  opts?: CommitOpts,
): Promise<CommitResult> {
  // (1) 온톨로지 검증
  const v = validateInput(ontology, input);
  if (!v.ok) throw new CommitRejected("ontology", v.reason);

  // (2) provenance 필수 필드 검증
  if (!provenanceOk(prov))
    throw new CommitRejected(
      "provenance",
      "provenance requires non-empty actor, origin, occurred_at",
    );

  const existingId = opts?.existingId;
  const isRelation = "from" in input;

  // (3) 유사 entity 조회 → 중복 후보. relation은 대상 아님.
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
    // embedding null(폴백) 또는 similar 미지원 → skipped 유지 (탐지 skip, 빈 배열).
  }

  // (5) id·version·status·last_confirmed 부여 후 저장 (SPEC 순서상 5단계지만,
  // 4단계 conflicts_with가 새 entity id를 참조하므로 먼저 저장한다).
  const prev = existingId ? await port.getEntity(existingId) : null;
  const governed = {
    id: existingId ?? ulid(),
    status: "draft" as const,
    version: prev ? prev.version + 1 : 1,
    last_confirmed: now,
    provenance: prov,
  };

  if (isRelation) {
    const relation: Relation = { ...(input as RelationInput), ...governed };
    await port.putRelation(relation);
    return { entity: relation, duplicates: [], duplicateDetection: "skipped" };
  }

  const entity: Entity = { ...input, ...governed };
  if (embedding) entity.embedding = embedding;
  await port.putEntity(entity);

  // (4) 모순 감지 — decision 한정 휴리스틱. 유사(중복 후보) decision 중 conclusion이
  // 다르면 conflicts_with 생성. 판정 입력은 conclusion 텍스트뿐 (v1 온톨로지에 subject 없음).
  // 양쪽 보존, 자동 해소 금지. relation도 게이트를 거쳐야 하므로 commit을 내부 재사용
  // (relation은 3·4단계를 타지 않아 무한 재귀 없음).
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
      );
      conflicts.push(rel.entity as Relation);
    }
  }

  return {
    entity,
    duplicates,
    duplicateDetection,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}
