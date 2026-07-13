// 커넥터 공통 적재 (PLAN 5.1). core가 아니라 front 계열 소비자 — 커넥터 pull을 순회하며
// commit 게이트로 넣는다(우회 금지). 멱등성: externalId를 attributes.external_id로 저장하고
// 재실행 시 FTS로 조회해 이미 있으면 skip.

import { commit } from "../core/commit.js";
import type { TypeDef } from "../core/ontology.js";
import type { StoragePort } from "../ports/storage.js";
import type { Connector } from "./types.js";

/** external_id로 기존 entity 존재 확인. FTS로 후보 조회 후 정확 일치(false positive 배제). */
async function exists(port: StoragePort, externalId: string): Promise<boolean> {
  const hits = await port.search({ text: externalId });
  return hits.some((e) => e.attributes.external_id === externalId);
}

/**
 * 커넥터 pull → commit 게이트 적재. 없으면 draft로 commit, 있으면 skip.
 * @param now ISO 8601 (core는 시간을 만들지 않는다 — front가 주입).
 */
export async function ingest(
  port: StoragePort,
  ontology: TypeDef[],
  connector: Connector,
  actor: string,
  now: string,
  since?: string,
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for await (const item of connector.pull(since)) {
    const { externalId, ...input } = item;
    if (await exists(port, externalId)) {
      skipped++;
      continue;
    }
    // external_id를 attributes에 확정 부여(멱등 키의 단일 출처는 ingest).
    await commit(
      port,
      ontology,
      {
        ...input,
        attributes: { ...input.attributes, external_id: externalId },
      },
      { actor, origin: `connector:${connector.name}`, occurred_at: now },
      now,
    );
    added++;
  }
  return { added, skipped };
}
