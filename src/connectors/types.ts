// 커넥터 계약 (PLAN 5.1). 커넥터는 EntityInput 생산자일 뿐 — 저장은 반드시 commit
// 게이트 경유(ingest). 프레임워크 아님: 타입 하나 + 공통 적재 함수 하나(ingest.ts)가 전부.

import type { EntityInput } from "../core/types.js";

/** 외부 소스 → EntityInput 스트림. externalId는 멱등 키(ingest가 attributes.external_id로 저장). */
export type Connector = {
  name: string;
  pull(since?: string): AsyncIterable<EntityInput & { externalId: string }>;
};
