// Draft clustering for the review queue (v7.1.3).
//
// The review sweep is the governance act this product is built around, and its cost is one decision per
// record. Drafts arrive in batches from the same source — a PR thread, a transcript, one agent session —
// so a queue of 40 is often 12 subjects. Grouping them lets a reviewer decide twelve times instead of
// forty, WITHOUT the shortcut that erases who wrote what: promotion is still per record, and
// `yoke verify` already takes a list.
//
// Similarity comes from the same `port.similar()` + threshold the duplicate gate uses. That is
// deliberate reuse rather than a second notion of "alike": if two records cluster here, the gate would
// have called them duplicate candidates, so a reviewer seeing them side by side is seeing the same
// judgment the gate already made. Records with no vector cluster alone — nothing was compared, and
// pretending otherwise would group by accident.
//
// ceiling: at 0.85 this groups RESTATEMENTS, not subjects. Measured with bge-m3 over six drafts: two
// near-identical deploy facts grouped, while a third deploy fact phrased differently and two on-call
// facts about one handover each stayed separate. That is the same property `npm run eval` measures on
// the contradiction detector — the threshold selects for saying the same thing again — and it is the
// right behaviour for the case this exists to serve, a batch import that re-chunked one paragraph.
// Grouping by SUBJECT is a different question and needs a different signal (a shared scope anchor, or
// the source document), not a lower threshold: lowering it merges unrelated records, and a reviewer who
// has to un-pick a group is slower than one deciding record by record.

import type { StoragePort } from "../ports/storage.js";
import { cosine, type Embedder, serializeText } from "./embedding.js";
import { normalizeNs } from "./namespace.js";
import type { TypeDef } from "./ontology.js";
import type { Entity } from "./types.js";

/** Same threshold as the gate's duplicate stage. Kept in one place per corpus, not re-tuned here. */
export const CLUSTER_THRESHOLD = 0.85;

export interface Cluster {
  /** Members, queue order preserved so a grouped queue reads in the same order as an ungrouped one. */
  members: Entity[];
  /** How many members had a vector to compare. `0` means this group is a single record nobody compared. */
  compared: number;
}

/**
 * Group entities that the duplicate threshold would call alike.
 *
 * Single-link agglomeration over the candidate lists: A joins B's group when either one retrieves the
 * other above threshold. Single-link chains (A~B, B~C ⇒ one group even if A and C are far apart), which
 * for a review queue is the forgiving direction — an over-large group still shows a reviewer records
 * that are related, while an over-split one hands them the same subject twice.
 *
 * @param neighbours how many candidates to ask the port for per record. The gate uses 5; a queue is
 *   denser than a commit, so 10 covers a batch import without turning this into a full scan.
 *   ceiling: one `similar()` call per draft. At a review queue's size (tens, occasionally hundreds)
 *   that is fine; a queue in the tens of thousands wants a clustering pass in the store instead.
 */
export async function clusterDrafts(
  port: StoragePort,
  ontology: TypeDef[],
  embedder: Embedder,
  entities: Entity[],
  opts?: { neighbours?: number; threshold?: number },
): Promise<Cluster[]> {
  const k = opts?.neighbours ?? 10;
  const threshold = opts?.threshold ?? CLUSTER_THRESHOLD;
  const index = new Map(entities.map((e, i) => [e.id, i]));
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

  const compared = new Set<number>();
  // A backend with no vector search groups nothing, and says so through `compared: 0` on every group
  // rather than by silently returning singletons that look like a clustering result.
  const canCompare = port.similar !== undefined;
  for (const [i, e] of canCompare ? entities.entries() : []) {
    // Re-embedded rather than read back: the port has `similar()` but no "give me this row's vector",
    // and adding one would touch every backend and the conformance suite for a screen-sized read. This
    // is the same text the gate embedded (`serializeText`), so the comparison is the gate's comparison.
    // ceiling: one embedding call per draft. A review queue is tens of records; a queue in the tens of
    // thousands wants clustering pushed into the store instead of a call per row.
    const vector = await embedder(
      serializeText(e.type, JSON.stringify(e.attributes), ontology),
    );
    if (!vector) continue;
    compared.add(i);
    for (const c of (await port.similar?.(vector, k)) ?? []) {
      if (c.id === e.id) continue;
      // `similar()` takes no namespace, so a candidate is re-checked here — the same filtering the
      // gate does on its own candidate list.
      if (normalizeNs(c.ns) !== normalizeNs(e.ns)) continue;
      const j = index.get(c.id);
      // Only cluster within the queue that was handed in. A draft is not grouped with a verified record
      // it resembles: this screen exists to promote drafts, and a group whose members cannot all be
      // acted on is a group a reviewer has to un-pick.
      if (j === undefined) continue;
      if (c.embedding && cosine(vector, c.embedding) >= threshold) union(i, j);
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
