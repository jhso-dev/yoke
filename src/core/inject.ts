// inject — context injection (KNOWLEDGE-POLICY 소프트 규칙 5: 주입은 엄격하게).
// search → effectiveStatus 계산 → 기본 verified만 통과 (stale/draft/deprecated 제외).
// citation 형식은 감사 추적의 최소 단위 — 테스트로 고정.

import type { StoragePort } from "../ports/storage.js";
import { effectiveStatus } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

export interface InjectItem {
  entity: Entity;
  effectiveStatus: Status;
  citation: string;
}

/** `[{type}:{id}@v{version}] {actor}, {occurred_at}` — 감사 인용 형식. */
function citation(e: Entity): string {
  return `[${e.type}:${e.id}@v${e.version}] ${e.provenance.actor}, ${e.provenance.occurred_at}`;
}

/**
 * 질의에 매칭되는 verified 지식을 인용과 함께 반환한다.
 * @param includeDraft draft도 포함 (라벨은 effectiveStatus로 구분됨). stale/deprecated는 항상 제외.
 */
export async function inject(
  port: StoragePort,
  ontology: TypeDef[],
  query: string,
  now: string,
  opts?: { includeDraft?: boolean; limit?: number },
): Promise<{ items: InjectItem[] }> {
  const results = await port.search({ text: query, limit: opts?.limit });
  const items: InjectItem[] = [];
  for (const entity of results) {
    const status = effectiveStatus(entity, ontology, now);
    const pass =
      status === "verified" || (opts?.includeDraft && status === "draft");
    if (!pass) continue;
    items.push({ entity, effectiveStatus: status, citation: citation(entity) });
  }
  return { items };
}
