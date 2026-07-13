// conformance suite self-check — verify the contract with an in-memory fake adapter.
// The fake exists only as a test helper (inside a .test.ts, not production code under src).

import type { Entity, Relation } from "../core/types.js";
import { describeStoragePort } from "./conformance.js";
import type { StoragePort, TextQuery } from "./storage.js";

function makeFake(): StoragePort {
  const entities: Entity[] = []; // append-only rows
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
      entities.push(e); // append-only: never modify existing rows
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
      const wantNs = q.ns == null || q.ns === "" ? null : q.ns;
      let out = [...latestById().values()].filter((e) =>
        `${e.type} ${JSON.stringify(e.attributes)}`
          .toLowerCase()
          .includes(needle),
      );
      // Namespace isolation (PLAN-V2 10.1): default ns sees only default-ns rows.
      out = out.filter((e) => (e.ns ?? null) === wantNs);
      if (q.type) out = out.filter((e) => e.type === q.type);
      if (q.status) out = out.filter((e) => e.status === q.status);
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      return out;
    },
    // similar unimplemented → capability absent
  };
}

describeStoragePort("in-memory fake", async () => makeFake());
