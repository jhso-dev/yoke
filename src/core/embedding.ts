// Embedding provider client (SPEC Embedder contract, PLAN 4.1).
// core receives an Embedder function by injection — the fetch implementation lives here, while tests use a deterministic stub.
// An embedding failure never blocks a commit (returns null → FTS fallback, warning only).

/** text → embedding vector. null = unavailable (unconfigured or failed) → caller falls back to FTS. */
export type Embedder = (text: string) => Promise<Float32Array | null>;

// Serializes the text that FTS and embeddings index. The adapter (FTS) and core (commit) must
// share this rule so the embedding and keyword index see the same representation. It lives in
// core and the adapter imports it (only adapter→core is allowed — core importing the adapter
// would violate the dependency-direction invariant).
export function serializeText(type: string, attributesJson: string): string {
  return `${type} ${attributesJson}`;
}

type Env = Record<string, string | undefined>;

/**
 * A fetch Embedder for OpenAI-compatible /embeddings endpoints.
 * Returns an always-null no-op when YOKE_EMBED_URL / YOKE_EMBED_MODEL are unset.
 * YOKE_EMBED_KEY, if present, is used for Bearer auth; if absent it is omitted (allowing keyless local endpoints).
 * No SDK — fetch is called directly.
 */
export function makeFetchEmbedder(env: Env): Embedder {
  const url = env.YOKE_EMBED_URL;
  const model = env.YOKE_EMBED_MODEL;
  const key = env.YOKE_EMBED_KEY;
  if (!url || !model) return async () => null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) headers.authorization = `Bearer ${key}`;

  return async (text: string): Promise<Float32Array | null> => {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        console.error(
          `yoke: embedding request failed (${res.status}) — falling back to FTS`,
        );
        return null;
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) {
        console.error(
          "yoke: embedding response malformed — falling back to FTS",
        );
        return null;
      }
      return Float32Array.from(vec);
    } catch (e) {
      console.error(
        `yoke: embedding error (${(e as Error).message}) — falling back to FTS`,
      );
      return null;
    }
  };
}
