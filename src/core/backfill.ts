// Backfill — the upgrade path for databases written before authorship became a graph edge.
//
// Entities committed before gate stage 4b carry their author only in the stored provenance field, so
// a person anchor (persona) cannot reach them: the anchor walks `authored_by` edges, and there are
// none. This re-derives the missing ones through the same gate, attributed to the recorded author
// rather than to whoever runs it.
//
// It lives in core rather than in the CLI because it is not a CLI feature: it is a repair on the
// knowledge graph, and every front adapter that offers it must offer the same one. It was CLI-only
// business logic until the web tier needed it, which is exactly the drift WEB-UI.md's "the API is
// only the HTTP exposure of core functions" rule exists to catch.

import type { StoragePort } from "../ports/storage.js";
import { commit } from "./commit.js";
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
