// conformance 스위트 자기 검증 — 인메모리 fake 어댑터로 계약을 확인한다.
// fake는 테스트 헬퍼로만 존재 (src의 프로덕션 코드가 아니라 .test.ts 안).

import type { Entity, Relation } from "../core/types.js";
import { describeStoragePort } from "./conformance.js";
import type { StoragePort, TextQuery } from "./storage.js";

function makeFake(): StoragePort {
  const entities: Entity[] = []; // append-only 행들
  const relations: Relation[] = [];

  const latestById = (): Map<string, Entity> => {
    const m = new Map<string, Entity>();
    for (const e of entities) {
      const cur = m.get(e.id);
      if (!cur || e.version > cur.version) m.set(e.id, e);
    }
    return m;
  };

  return {
    async init() {},
    close() {},

    async putEntity(e) {
      entities.push(e); // append-only: 기존 행 변경 없음
    },
    async getEntity(id, version) {
      const rows = entities.filter((e) => e.id === id);
      if (rows.length === 0) return null;
      if (version !== undefined)
        return rows.find((e) => e.version === version) ?? null;
      return rows.reduce((a, b) => (b.version > a.version ? b : a));
    },

    async putRelation(r) {
      relations.push(r);
    },
    async neighbors(id, relType, dir) {
      return relations.filter((r) => {
        const matchDir =
          dir === "out"
            ? r.from === id
            : dir === "in"
              ? r.to === id
              : r.from === id || r.to === id;
        const matchType = relType === undefined || r.type === relType;
        return matchDir && matchType;
      });
    },

    async search(q: TextQuery) {
      const needle = q.text.toLowerCase();
      let out = [...latestById().values()].filter((e) =>
        `${e.type} ${JSON.stringify(e.attributes)}`
          .toLowerCase()
          .includes(needle),
      );
      if (q.type) out = out.filter((e) => e.type === q.type);
      if (q.status) out = out.filter((e) => e.status === q.status);
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      return out;
    },
    // similar 미구현 → capability 부재
  };
}

describeStoragePort("in-memory fake", async () => makeFake());
