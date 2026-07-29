// conformance suite self-check — verify the contract with an in-memory fake adapter.
// The fake exists only as a test helper (inside a .test.ts, not production code under src).

import type { Entity, Relation } from "../core/types.js";
import { describeStoragePort } from "./conformance.js";
import {
  type ListQuery,
  page,
  type StoragePort,
  type TextQuery,
} from "./storage.js";

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

  const latestRelations = (): Relation[] => {
    const m = new Map<string, Relation>();
    for (const r of relations) {
      const cur = m.get(r.id);
      if (!cur || r.version > cur.version) m.set(r.id, r);
    }
    return [...m.values()];
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
      // AND-of-prefix-tokens — the port's search semantics (matches sqlite/kuzu/qdrant).
      const queryTokens = q.text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      if (queryTokens.length === 0) return [];
      const wantNs = q.ns == null || q.ns === "" ? null : q.ns;
      let out = [...latestById().values()].filter((e) => {
        const textTokens = `${e.type} ${JSON.stringify(e.attributes)}`
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean);
        return queryTokens.every((qt) =>
          textTokens.some((tt) => tt.startsWith(qt)),
        );
      });
      // Namespace isolation (PLAN-V2 10.1): default ns sees only default-ns rows.
      out = out.filter((e) => (e.ns ?? null) === wantNs);
      if (q.type) out = out.filter((e) => e.type === q.type);
      if (q.status) out = out.filter((e) => e.status === q.status);
      if (q.limit !== undefined) out = out.slice(0, q.limit);
      return out;
    },

    async listEntities(q) {
      return page(listFilter([...latestById().values()], q), q.limit);
    },
    async listRelations(q) {
      return page(listFilter(latestRelations(), q), q.limit);
    },
    // similar unimplemented → capability absent
  };
}

/** latest version → ns/type/status/cursor → ascending id, then over-read by one for `next`.
 * The fake stays deliberately strict: a lenient fake hides the bugs a real backend then has. */
function listFilter<
  T extends { id: string; type: string; status: string; ns?: string | null },
>(rows: T[], q: ListQuery): T[] {
  const wantNs = q.ns == null || q.ns === "" ? null : q.ns;
  return rows
    .filter(
      (r) =>
        (r.ns ?? null) === wantNs &&
        (q.type === undefined || r.type === q.type) &&
        (q.status === undefined || r.status === q.status) &&
        (q.after === undefined || r.id > q.after),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, q.limit === undefined ? undefined : q.limit + 1);
}

describeStoragePort("in-memory fake", async () => makeFake());
