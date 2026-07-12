// storage port — core가 정의하는 백엔드 계약 (SPEC.md의 StoragePort 그대로).
// 어댑터(SQLite, 벡터/그래프 DB)가 구현하고 conformance 스위트를 통과해야 한다.
// 물리 삭제 API는 의도적으로 없다 — 지식은 append-only.

import type { Entity, Relation } from "../core/types.js";

/** 키워드 검색(FTS) 질의. text 필수, 나머지는 선택 필터. */
export interface TextQuery {
  text: string;
  type?: string;
  status?: string;
  limit?: number;
}

export interface StoragePort {
  /** 백엔드 준비 (스키마 생성 등). 멱등이어야 한다. */
  init(): Promise<void>;
  /** 리소스 해제. */
  close(): void;

  /** append-only: (id, version) 행 추가. 기존 행 변경 금지. */
  putEntity(e: Entity): Promise<void>;
  /** version 미지정 시 최신, 지정 시 해당 버전. 없으면 null. */
  getEntity(id: string, version?: number): Promise<Entity | null>;

  putRelation(r: Relation): Promise<void>;
  /** id에 연결된 relation. dir 미지정 시 양방향, relType으로 타입 필터. */
  neighbors(
    id: string,
    relType?: string,
    dir?: "in" | "out",
  ): Promise<Relation[]>;

  /** 키워드(FTS) 검색. 무결과 시 빈 배열. */
  search(q: TextQuery): Promise<Entity[]>;

  /** optional capability — 없으면 core가 키워드 검색으로 폴백. */
  similar?(embedding: Float32Array, k: number): Promise<Entity[]>;
}
