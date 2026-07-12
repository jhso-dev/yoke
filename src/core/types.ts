// yoke core 타입 — SPEC.md의 Entity/Relation/Provenance 계약.
// 로직 없음. 이 파일의 존재 이유: id/status/version/last_confirmed는 commit 게이트만
// 부여하도록 타입 수준에서 강제 (Input 형과 저장 형을 분리).

/** 지식 상태. draft로 진입, verify로 승격, 신선도 만료/폐기로 stale/deprecated. */
export type Status = "draft" | "verified" | "stale" | "deprecated";

/** 지식의 출처. 감사 추적의 최소 단위. 날짜는 ISO 8601 string (Date 객체 저장 금지). */
export interface Provenance {
  /** person entity id 또는 agent 식별자 (필수) */
  actor: string;
  /** 'cli' | 'mcp' | 'connector:github-pr' | ... */
  origin: string;
  /** ISO 8601 */
  occurred_at: string;
}

/** 게이트가 부여하는 저장 전용 필드. Input에는 없다. */
interface Governed {
  /** ULID. 소비처는 불투명 문자열로만 취급 */
  id: string;
  status: Status;
  /** 1부터. 수정은 새 버전 행 추가 (덮어쓰기 금지) */
  version: number;
  /** ISO 8601. verify 시 갱신 */
  last_confirmed: string;
  provenance: Provenance;
}

/** commit이 받는 entity 입력형. 게이트 부여 필드는 없다. */
export interface EntityInput {
  /** 온톨로지에 등록된 entity 타입 (미등록 시 commit 거절) */
  type: string;
  /** 온톨로지의 타입별 스키마로 검증 */
  attributes: Record<string, unknown>;
}

/** 저장된 entity. 게이트를 통과한 결과물. */
export interface Entity extends EntityInput, Governed {
  /** 중복 탐지·시맨틱 검색용 (sqlite-vec) */
  embedding?: Float32Array;
}

/** commit이 받는 relation 입력형. entity 입력 + 방향성. */
export interface RelationInput extends EntityInput {
  /** entity id (from) */
  from: string;
  /** entity id (to) */
  to: string;
}

/** 저장된 relation. entity와 동일 골격 + 방향성. relation 자체가 지식이다. */
export interface Relation extends RelationInput, Governed {}
