// lifecycle — status 전이 + 신선도 (KNOWLEDGE-POLICY 소프트 규칙 4·7).
// verify/deprecate는 지식 내용 변경이 아니라 상태 전이이므로 commit 게이트가 아닌
// 별도 쓰기 경로다. putEntity 직접 호출은 이 파일 안에만 존재한다.
// 시간은 주입받는다 — core에서 new Date() 금지 (SPEC 시간 주입).

import type { StoragePort } from "../ports/storage.js";
import type { TypeDef } from "./ontology.js";
import type { Entity, Status } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * 상태 전이 공통 경로. getEntity 후 새 버전 행을 append-only로 추가한다.
 * provenance는 승격/폐기 행위의 감사 추적으로 갱신된다 (origin: 'lifecycle').
 */
async function transition(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
  status: Status,
): Promise<Entity[]> {
  const out: Entity[] = [];
  for (const id of ids) {
    const prev = await port.getEntity(id);
    // 미존재 id는 조용히 skip하지 않는다 — 승격/폐기는 명시 행위.
    if (!prev) throw new Error(`cannot transition unknown entity: ${id}`);
    const next: Entity = {
      ...prev,
      status,
      version: prev.version + 1,
      last_confirmed: now,
      provenance: { actor, origin: "lifecycle", occurred_at: now },
    };
    await port.putEntity(next);
    out.push(next);
  }
  return out;
}

/** status→'verified', last_confirmed=now. 새 버전 행 추가 (append-only). */
export function verify(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "verified");
}

/** status→'deprecated'. verify와 동일 메커니즘 (append-only 새 버전). */
export function deprecate(
  port: StoragePort,
  ids: string[],
  actor: string,
  now: string,
): Promise<Entity[]> {
  return transition(port, ids, actor, now, "deprecated");
}

/**
 * 신선도 판정. 타입의 ttl_days 미지정이면 항상 fresh.
 * 지정 시 last_confirmed + ttl_days ≥ now (밀리초 산술, dep 없음).
 */
export function isFresh(e: Entity, ontology: TypeDef[], now: string): boolean {
  const ttl = ontology.find((t) => t.name === e.type)?.ttl_days;
  if (ttl === undefined) return true;
  return Date.parse(e.last_confirmed) + ttl * DAY_MS >= Date.parse(now);
}

/**
 * 읽기 시점 상태. verified인데 신선하지 않으면 'stale' (저장하지 않음).
 * 그 외에는 저장된 status 그대로.
 */
export function effectiveStatus(
  e: Entity,
  ontology: TypeDef[],
  now: string,
): Status {
  if (e.status === "verified" && !isFresh(e, ontology, now)) return "stale";
  return e.status;
}
