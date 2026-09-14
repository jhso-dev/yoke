// conformance suite self-check — verify the contract with an in-memory fake adapter.
// The fake exists only as a test helper (inside a .test.ts, not production code under src).

import { requireEveryTerm, tokenize } from "../core/rank.js";
import type { Entity, Relation } from "../core/types.js";
import { describeStoragePort } from "./conformance.js";
import {
  ConflictError,
  DEFAULT_SEARCH_LIMIT,
  type ListQuery,
  page,
  type StoragePort,
  type TextQuery,
} from "./storage.js";

// The fake's own ranker. Every shipping adapter ranks with a native index, so this is the only thing
// in the tree that has to satisfy SPEC search clauses 6 and 8 in JavaScript — it lives beside the fake
// that needs it rather than in core, which ships nothing that calls it.

/**
 * Does `docText` satisfy `qTokens` under clause 8? A query token matches any document token it
 * PREFIXES, which is case 6b (Hangul stay attached to their stem, so `parseArgs` must reach
 * `parseArgs로`).
 *
 * One copy, because two copies of a matching rule is two search semantics.
 */
export function matchesTokens(
  qTokens: string[],
  docText: string,
  terms: "auto" | "all" = "auto",
): boolean {
  if (qTokens.length === 0) return false;
  const docTokens = tokenize(docText);
  const hit = (qt: string) => docTokens.some((dt) => dt.startsWith(qt));
  return requireEveryTerm(qTokens.length, terms)
    ? qTokens.every(hit)
    : qTokens.some(hit);
}

/** BM25's usual constants: k1 bounds how much repetition helps, b how much length is penalised. */
const K1 = 1.2;
const B = 0.75;

/**
 * Sort `rows` best-match first for `query`, by BM25 over the text `textOf` returns.
 *
 * Stable within a score, and the tiebreak is the row's own order — so two equally relevant records
 * keep whatever order the caller had, which for these adapters is id order and therefore
 * deterministic across backends.
 *
 * A query token scores against any document token it PREFIXES, matching how these adapters decide
 * what matched in the first place; a ranker that scored only exact tokens would rank a Korean hit
 * at zero and sort the one relevant record last.
 */
export function rankByRelevance<T>(
  rows: T[],
  query: string,
  textOf: (row: T) => string,
): T[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || rows.length === 0) return rows;

  const docs = rows.map((row) => tokenize(textOf(row)));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;

  // Document frequency per query token, over this candidate set. It is the set the caller is
  // ranking, so "how rare is this token here" is the only idf available and the right one.
  const df = qTokens.map(
    (qt) => docs.filter((d) => d.some((t) => t.startsWith(qt))).length,
  );

  const scored = rows.map((row, i) => {
    const d = docs[i];
    let score = 0;
    for (let k = 0; k < qTokens.length; k++) {
      const tf = d.filter((t) => t.startsWith(qTokens[k])).length;
      if (tf === 0) continue;
      // Standard idf with the +0.5 smoothing, so a token present in every candidate contributes
      // almost nothing rather than a negative weight.
      const idf = Math.log(1 + (rows.length - df[k] + 0.5) / (df[k] + 0.5));
      score +=
        (idf * (tf * (K1 + 1))) /
        (tf + K1 * (1 - B + (B * d.length) / (avgLen || 1)));
    }
    return { row, score, i };
  });

  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.row);
}

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
      // The (id, version) primary key is part of the contract, so the minimum honest fake enforces it
      // too: a duplicate is the version-race loser and must raise the typed ConflictError (C1/C2).
      if (entities.some((r) => r.id === e.id && r.version === e.version))
        throw new ConflictError(`version conflict on ${e.id}`);
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
      // Core's matcher, not a second copy of the rule: a fake with its own semantics could satisfy
      // cases the real adapters cannot, which would make this self-check worse than nothing. This
      // fake DID have its own copy, and case 6e caught it — an inlined `every()` here kept passing
      // the strict half while the five adapters had moved to clause 8.
      const queryTokens = tokenize(q.text);
      if (queryTokens.length === 0) return [];
      const textOf = (e: Entity) => `${e.type} ${JSON.stringify(e.attributes)}`;
      const wantNs = q.ns == null || q.ns === "" ? null : q.ns;
      let out = [...latestById().values()].filter((e) =>
        matchesTokens(queryTokens, textOf(e), q.terms),
      );
      // Namespace isolation (ENTERPRISE "namespaces"): default ns sees only default-ns rows.
      out = out.filter((e) => (e.ns ?? null) === wantNs);
      if (q.type) out = out.filter((e) => e.type === q.type);
      if (q.status) {
        const want = Array.isArray(q.status) ? q.status : [q.status];
        out = out.filter((e) => want.includes(e.status));
      }
      // Search clauses 6 and 7: rank BEFORE cutting, and cut even when no limit was named. Spelled
      // out here because this fake is what shows the contract is satisfiable by the minimum honest
      // implementation — if it can only be met with FTS5, it is not a port contract.
      out = rankByRelevance(out, q.text, textOf);
      return out.slice(0, q.limit ?? DEFAULT_SEARCH_LIMIT);
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
