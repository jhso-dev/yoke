// What both corpus loaders must do before either can write a record: probe the embedder, open the
// store, spread occurred_at deterministically. Each loader keeps its own corpus shape and its own
// spread; only the machinery is shared.

import { commit } from "../dist/core/commit.js";
import { makeFetchEmbedder } from "../dist/core/embedding.js";
import { openStore } from "../dist/front/store.js";

/** No Math.random: a reload must produce the same corpus, or "it changed" stops being evidence of
 *  anything. `span` is the caller's — how many days wide the corpus is. */
export function dateSpread(now, span) {
  const iso = (daysAgo) =>
    new Date(Date.parse(now) - daysAgo * 86400000).toISOString();
  return {
    iso,
    dateFor: (key) => {
      let h = 0;
      for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return iso(h % span);
    },
  };
}

/** The embedder, and a line saying whether vectors are on. */
export async function probeEmbedder(env, offNote) {
  const embedder = makeFetchEmbedder(env);
  const vectors = (await embedder("probe")) !== null;
  console.log(
    vectors
      ? `embedder: ${env.YOKE_EMBED_MODEL} — vectors on`
      : `embedder: none — ${offNote}`,
  );
  return { embedder, vectors };
}

/** An opened store (seeded by `openStore`, exactly as a server seeds one) plus the commit helper the
 *  loaders write through. Idempotent, so re-running a loader stays safe. */
export async function openSeededStore({ db, env, embedder, origin, ns }) {
  const store = await openStore({ db }, env);
  const ontology = store.loadOntology(null);

  const add = async (input, actor, at, existingId) => {
    const { entity } = await commit(
      store,
      ontology,
      input,
      { actor, origin, occurred_at: at },
      at,
      { embedder, existingId, ...(ns === undefined ? {} : { ns }) },
    );
    return entity.id;
  };
  return { store, add };
}
