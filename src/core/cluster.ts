// Draft clustering for the review queue (v7.1.3).
//
// The review sweep is the governance act this product is built around, and its cost is one decision per
// record. Drafts arrive in batches from the same source — a PR thread, a transcript, one agent session —
// so a queue of 40 is often 12 subjects. Grouping them lets a reviewer decide twelve times instead of
// forty, WITHOUT the shortcut that erases who wrote what: promotion is still per record, and
// `yoke verify` already takes a list.
//
// The threshold is the duplicate gate's, so "alike" means one thing in this product — but the COMPARISON
// is all-pairs within the queue, not a vector search over the store.
//
// That is not a shortcut, it is the fix for one. Asking `similar(vector, k)` returns the k nearest records
// in the whole store and then only the queue members among them survive, so on a store that has been used
// for a while the queue's own pairs get pushed out by closer verified records. Measured: two drafts at
// cosine 0.9992 — far above the 0.85 threshold — failed to cluster with 30 verified records sitting
// strictly closer to each of them, and no value of k fixes that, because any k can be swamped. The queue
// is a KNOWN list, so comparing it against itself is both exact and simpler; it also means this needs no
// vector search from the backend at all.
//
// Records with no vector cluster alone — nothing was compared, and pretending otherwise would group by
// accident.
//
// ceiling: at 0.85 this groups RESTATEMENTS, not subjects. Measured with bge-m3 over six drafts: two
// near-identical deploy facts grouped, while a third deploy fact phrased differently and two on-call
// facts about one handover each stayed separate. That is the same property `npm run eval` measures on
// the contradiction detector — the threshold selects for saying the same thing again — and it is the
// right behaviour for the case this exists to serve, a batch import that re-chunked one paragraph.
// Grouping by SUBJECT is a different question and needs a different signal (a shared scope anchor, or
// the source document), not a lower threshold: lowering it merges unrelated records, and a reviewer who
// has to un-pick a group is slower than one deciding record by record.

import { cosine, type Embedder, serializeText } from "./embedding.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

/** Same threshold as the gate's duplicate stage. Kept in one place per corpus, not re-tuned here. */
export const CLUSTER_THRESHOLD = 0.85;

/**
 * How many embedding requests are in flight at once.
 *
 * Small on purpose: the endpoint is often one local server, and the whole point of the bound is that a
 * 2,000-draft queue must not become 2,000 simultaneous requests. Four is what the extractor's default
 * concurrency settled on for the same endpoint.
 */
const EMBED_CONCURRENCY = 4;

export interface Cluster {
  /** Members, queue order preserved so a grouped queue reads in the same order as an ungrouped one. */
  members: Entity[];
  /** How many members had a vector to compare. `0` means this group is a single record nobody compared. */
  compared: number;
}

/**
 * Group entities that the duplicate threshold would call alike.
 *
 * Single-link agglomeration: A joins B's group when they are within threshold. Single-link chains
 * (A~B, B~C ⇒ one group even if A and C are far apart), which for a review queue is the forgiving
 * direction — an over-large group still shows a reviewer records that are related, while an over-split one
 * hands them the same subject twice.
 *
 * ceiling: one embedding call per draft, and an O(n²) comparison over the queue. A review queue is tens of
 * records, occasionally hundreds, where n² in memory is nothing; a queue in the tens of thousands wants a
 * clustering pass pushed into the store, and would want the embeddings read back rather than recomputed.
 */
export async function clusterDrafts(
  ontology: TypeDef[],
  embedder: Embedder,
  entities: Entity[],
  opts?: { threshold?: number },
): Promise<Cluster[]> {
  const threshold = opts?.threshold ?? CLUSTER_THRESHOLD;
  /** Union-find over queue positions. */
  const parent = entities.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    // Path compression, so a long single-link chain does not make this quadratic.
    let cur = i;
    while (parent[cur] !== cur) {
      const next = parent[cur];
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    // Lower index wins, which keeps a group's root at its earliest queue position and makes the output
    // order deterministic across backends (invariant 2).
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Every queue member's vector, once. Re-embedded rather than read back: the port exposes `similar()` but
  // no "give me this row's vector", and adding one would touch every backend and the conformance suite for
  // a screen-sized read. This is the same text the gate embedded (`serializeText`), so the comparison is
  // the gate's comparison.
  //
  // Bounded, and that is not a detail. The callers hand this the WHOLE unpaginated draft queue, so an
  // unbounded `Promise.all` fired one request per draft simultaneously — 2,000 drafts after a batch import
  // is 2,000 concurrent POSTs at a local embedding server, which serializes or refuses them and takes the
  // command down with it. The extractor already faced this and has YOKE_EXTRACT_CONCURRENCY; this uses the
  // same shape of bound.
  const vectors: (Float32Array | null)[] = [];
  for (let start = 0; start < entities.length; start += EMBED_CONCURRENCY) {
    const window = entities.slice(start, start + EMBED_CONCURRENCY);
    vectors.push(
      ...(await Promise.all(
        window.map((e) =>
          embedder(
            serializeText(e.type, JSON.stringify(e.attributes), ontology),
          ),
        ),
      )),
    );
  }
  const compared = new Set<number>();
  vectors.forEach((v, i) => {
    if (v) compared.add(i);
  });
  for (let i = 0; i < entities.length; i++) {
    const a = vectors[i];
    if (!a) continue;
    for (let j = i + 1; j < entities.length; j++) {
      const b = vectors[j];
      if (!b) continue;
      if (cosine(a, b) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, Cluster>();
  for (const [i, e] of entities.entries()) {
    const root = find(i);
    const g = groups.get(root) ?? { members: [], compared: 0 };
    g.members.push(e);
    if (compared.has(i)) g.compared += 1;
    groups.set(root, g);
  }
  // Biggest groups first — the sweep's cheapest wins are the batches — then by queue position.
  return [...groups.entries()]
    .sort((a, b) => b[1].members.length - a[1].members.length || a[0] - b[0])
    .map(([, g]) => g);
}
