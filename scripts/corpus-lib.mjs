// What both corpus loaders must do before either can write a record: probe the embedder, open and
// seed the store, plant the bootstrap actor, spread occurred_at deterministically. Each loader keeps
// its own corpus shape and its own spread; only the machinery is shared.

import { commit } from "../dist/core/commit.js";
import { makeFetchEmbedder } from "../dist/core/embedding.js";
import { verify } from "../dist/core/lifecycle.js";
import { seedOntology } from "../dist/core/ontology.js";
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

/**
 * A store with the ontology seeded and `yoke:system` present, plus the commit helper to write through.
 *
 * The bootstrap actor is what `yoke init` plants. Without it `yoke mcp` refuses the database outright
 * ("not initialized"), so a corpus loaded here reads fine from the CLI and the web UI and is unusable
 * over the one interface the product exists to serve. Idempotent, so re-running a loader stays safe.
 */
export async function openSeededStore({ db, env, embedder, origin, ns }) {
  const store = await openStore({ db }, env);
  await store.init();
  const ontology = seedOntology();
  await store.saveOntology(ontology);

  if (!(await store.getEntity("yoke:system"))) {
    const at = "2025-01-01T00:00:00.000Z";
    const { entity } = await commit(
      store,
      ontology,
      { type: "person", attributes: { name: "yoke" } },
      { actor: "yoke:system", origin: "seed", occurred_at: at },
      at,
      { existingId: "yoke:system" },
    );
    await verify(store, [entity.id], "yoke:system", at);
  }

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
