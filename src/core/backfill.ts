// Backfill — repairs for things derived FROM knowledge rather than knowledge itself. Two of them now:
// the authorship graph, and the vector index.
//
// Entities committed before gate stage 4b carry their author only in the stored provenance field, so
// a person anchor (persona) cannot reach them: the anchor walks `authored_by` edges, and there are
// none. This re-derives the missing ones through the same gate, attributed to the recorded author
// rather than to whoever runs it.
//
// Both live in core rather than in the CLI because neither is a CLI feature: they are repairs, and
// every front adapter that offers one must offer the same one. Authorship was CLI-only business logic
// until the web tier needed it, which is exactly the drift WEB-UI.md's "the API is only the HTTP
// exposure of core functions" rule exists to catch.

import type { StoragePort } from "../ports/storage.js";
import { commit } from "./commit.js";
import { type Embedder, serializeText } from "./embedding.js";
import { listVersions } from "./lifecycle.js";
import type { TypeDef } from "./ontology.js";

/** Idempotent: a second run creates nothing, because it skips authors already linked. */
export async function backfillAuthorship(
  port: StoragePort,
  ontology: TypeDef[],
  now: string,
  opts?: { ns?: string | null },
): Promise<{ scanned: number; created: number }> {
  const ns = opts?.ns ?? null;
  let scanned = 0;
  let created = 0;
  // One unfiltered enumeration, not a union over the three statuses — it cannot miss a status
  // someone adds later, which the union quietly would.
  const ids = (await port.listEntities({ ns })).items.map((e) => e.id);
  for (const id of ids) {
    scanned++;
    const authored = await port.neighbors(id, "authored_by", "out");
    const linked = new Set(authored.map((r) => r.to));
    // Every version that passed the commit gate is an authorship; verify/deprecate are not (they
    // carry origin 'lifecycle' and overwrite the latest version's provenance actor, which is exactly
    // why reading only the latest row would credit the promoter).
    for (const ver of await listVersions(port, id)) {
      const prov = ver.provenance;
      if (prov.origin === "lifecycle" || prov.actor === id) continue;
      if (linked.has(prov.actor)) continue;
      await commit(
        port,
        ontology,
        { type: "authored_by", attributes: {}, from: id, to: prov.actor },
        prov,
        now,
        { ns },
      );
      linked.add(prov.actor);
      created++;
    }
  }
  return { scanned, created };
}

/** How many rows one page of the embedding walk loads. Independent of the caller's `limit`, which
 * bounds how many rows are EMBEDDED — each of those costs a provider round trip, so the two numbers
 * are not the same size. */
const EMBED_PAGE = 200;

/**
 * Recompute the vector index for stored entities.
 *
 * Coverage was a function of which interface wrote the row: `.mcp.json` configures the embedder for
 * the MCP server's process only, so anything created through the CLI or the web tier arrived with no
 * vector at all — measured at 1 of 3 entities in this repo's own database. The knowledge was complete;
 * the derived index was not (SPEC "The vector index"), and this is how it is repaired.
 *
 * Re-embeds every row it reaches rather than skipping covered ones, because `getEntity` does not
 * return embeddings — the port cannot be asked which rows have a vector. `putEmbedding` is keyed by
 * `id`, so re-running is idempotent rather than duplicative.
 *
 * Bounded and resumable for the same reason `staleEntities` is: cost is proportional to the corpus
 * rather than to the answer. `next` is the last row EXAMINED, so resuming skips nothing, and `scanned`
 * says how much of the corpus was covered — a bare "embedded 12" would read as a corpus-wide claim.
 *
 * @param rebuild drop the vector index before the first write. This is the only way to change
 *   dimension, so it is what makes switching embedding model possible; applied ONCE, on the first row
 *   that produces a vector, or each row would wipe the one before it.
 */
export async function backfillEmbeddings(
  port: StoragePort,
  opts: {
    embedder: Embedder;
    ns?: string | null;
    limit?: number;
    after?: string;
    rebuild?: boolean;
  },
): Promise<{
  scanned: number;
  embedded: number;
  skipped: number;
  next: string | null;
}> {
  // No vector support on this backend (kuzu). Say so by doing nothing rather than by throwing: a
  // repair that cannot apply is not an error, and the caller reports the zero.
  if (!port.putEmbedding)
    return { scanned: 0, embedded: 0, skipped: 0, next: null };

  let scanned = 0;
  let embedded = 0;
  let skipped = 0;
  let rebuildPending = opts.rebuild === true;
  let after = opts.after;

  for (;;) {
    const page = await port.listEntities({
      ns: opts.ns,
      after,
      limit: EMBED_PAGE,
    });
    for (const e of page.items) {
      scanned++;
      // The SAME expression the gate uses (commit.ts stage 3). If these ever diverge, a backfilled
      // vector lands in a different place than one written at commit time and duplicate detection
      // starts comparing across two representations.
      const vector = await opts.embedder(
        serializeText(e.type, JSON.stringify(e.attributes)),
      );
      if (!vector) {
        // Provider unconfigured or failing. Counted, never fatal — the same principle as the gate's:
        // an embedding problem must not become a data problem.
        skipped++;
      } else {
        await port.putEmbedding(
          { ...e, embedding: vector },
          rebuildPending ? { rebuild: true } : undefined,
        );
        rebuildPending = false;
        embedded++;
      }
      if (opts.limit !== undefined && embedded >= opts.limit)
        return { scanned, embedded, skipped, next: e.id };
    }
    if (page.next === null) return { scanned, embedded, skipped, next: null };
    after = page.next;
  }
}
