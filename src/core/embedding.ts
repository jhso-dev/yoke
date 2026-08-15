// Embedding provider client (SPEC Embedder contract, PLAN 4.1).
// core receives an Embedder function by injection — the fetch implementation lives here, while tests use a deterministic stub.
// An embedding failure never blocks a commit (returns null → warning only; RETRIEVAL falls back to
// FTS, duplicate detection is skipped — SPEC "Stage 3 has no FTS fallback").

import type { TypeDef } from "./ontology.js";

/** text → embedding vector. null = unavailable (unconfigured or failed): retrieval falls back to
 * FTS; the commit gate skips duplicate detection rather than approximating it. */
export type Embedder = (text: string) => Promise<Float32Array | null>;

// Serializes the text that FTS and embeddings index. The adapter (FTS) and core (commit) must
// share this rule so the embedding and keyword index see the same representation. It lives in
// core and the adapter imports it (only adapter→core is allowed — core importing the adapter
// would violate the dependency-direction invariant).
//
// `ontology` is optional because the FTS callers are storage adapters, which are constructed with a
// path and have no ontology in hand. It only affects the ORDER of the values in the prose key, and
// FTS ranks a bag of words, so the halves still see the same key — see `proseText`.
//
// `key` is the variant the STORE is pinned to (`resolveIndexKey`), never the ambient env: a database
// keyed one way and rewritten by a process configured the other way is a mixed index, and a mixed
// index is invisible — every row still looks fine and only ranking degrades. Defaulting to "default"
// means a caller that forgets writes what every legacy database already holds.
export function serializeText(
  type: string,
  attributesJson: string,
  ontology?: TypeDef[],
  key: IndexKey = "default",
): string {
  if (key === "prose") return proseText(type, attributesJson, ontology ?? []);
  return `${type} ${attributesJson}`;
}

type Env = Record<string, string | undefined>;

/** What a store's index is keyed on. Recorded per database — see `resolveIndexKey`. */
export type IndexKey = "default" | "prose";

/** The meta key holding a database's `IndexKey`. Absent = a database written before it existed. */
export const INDEX_KEY_META = "index_key";

/** The `getMeta`/`setMeta` half of the storage port, structurally — so this file needs no import
 * from `ports/`, and a caller can pass any store. */
export interface MetaStore {
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/**
 * Which key variant a store is pinned to, given what it has RECORDED and whether it holds anything.
 *
 * The env chooses only for a database that has indexed nothing yet. Once a row exists the recorded
 * value decides, and an unrecorded one reads as "default" — which is exactly what a legacy database
 * holds, so nothing already written is re-interpreted.
 *
 * Pure and synchronous because sqlite resolves it inside synchronous code; the async stores use
 * `resolveIndexKey` below, which is this plus the read and the write-back.
 */
export function pinIndexKey(
  stored: string | null,
  empty: boolean,
  env: Env = process.env,
): IndexKey {
  if (stored === "prose" || stored === "default") return stored;
  return empty && proseKeyEnabled(env) ? "prose" : "default";
}

/**
 * Read a store's pinned key variant, stamping it on first use.
 *
 * Called by whoever is about to derive index text — core's commit gate before it embeds, the
 * adapters before they write FTS — so both halves of one hybrid index agree even when the process
 * writing the second half has a different env than the one that wrote the first.
 *
 * `isEmpty` answers "has this store indexed anything yet", and is only consulted when nothing is
 * recorded. Changing a recorded variant is `yoke backfill --embeddings --rebuild`, which writes the
 * meta itself; nothing else here overwrites it.
 */
export async function resolveIndexKey(
  store: MetaStore,
  isEmpty: () => Promise<boolean> | boolean,
  env: Env = process.env,
): Promise<IndexKey> {
  const stored = await store.getMeta(INDEX_KEY_META);
  if (stored === "prose" || stored === "default") return stored;
  const key = pinIndexKey(stored, await isEmpty(), env);
  await store.setMeta(INDEX_KEY_META, key);
  return key;
}

/**
 * Whether the index is keyed on prose instead of the attributes JSON (`YOKE_INDEX_KEY=prose`).
 *
 * Why the key is a question at all: LongMemEval (arXiv 2410.10813) measured +9.4% recall@k from
 * expanding the indexed key with a natural-language rendering of the value — and, in the same
 * experiment, no gain from a compressed form alone. The win is prose CONCATENATED with the original
 * value, which is what `proseText` builds.
 *
 * The env only ever chooses for a database that has indexed NOTHING, and the choice is then recorded
 * in the store (`resolveIndexKey`). It used to be read on every serialization, which meant one
 * command run without the flag re-keyed whatever rows it touched and left a mixed index behind —
 * measured, and it invalidated a benchmark run.
 *
 * ceiling: this is the one place in core that reads `process.env` — everywhere else the front
 * adapters pass env in (`envKeywordWeight`). It stays ambient because the stamp can happen inside a
 * storage adapter, which is constructed with a path and no env. Delete this function if the prose
 * key does not outlive the experiment; the stored meta stays either way.
 *
 * `YOKE_EMBED_KEY=prose` is accepted as an alias because that name was asked for, and it is already
 * taken: it is the embedding endpoint's bearer token (see `makeFetchEmbedder`, which ignores the
 * literal "prose" for that reason).
 */
export function proseKeyEnabled(env: Env = process.env): boolean {
  return env.YOKE_INDEX_KEY === "prose" || env.YOKE_EMBED_KEY === "prose";
}

/**
 * Attributes that are bookkeeping rather than what a record says. `sources` is in the set because
 * it is the verbatim span rather than the record's own words — the two callers put it back where it
 * belongs to them (the prose key keeps it, the relater's prompt does not).
 */
export const NOT_CONTENT = new Set([
  "external_id",
  "sources",
  "author",
  "topic",
  "key",
  "status",
]);

/**
 * The values a record's attributes carry, in declared-ontology order, bookkeeping dropped.
 *
 * Declared order, not written order, for the reason `summarize` gives: what a type declares FIRST is
 * what it wants read, and attribute order as written is caller-controlled. Undeclared attributes
 * follow, in written order.
 *
 * Shared by the prose index key (below) and the relater's prompt (`relateText`), which asked the
 * same question of a record — "what does this actually say" — and answered it twice.
 */
export function contentValues(
  entity: { type: string; attributes: Record<string, unknown> },
  ontology: TypeDef[],
): string[] {
  const def = ontology.find((t) => t.name === entity.type);
  const declared = def ? Object.keys(def.attrs) : [];
  const keys = [
    ...declared,
    ...Object.keys(entity.attributes).filter((k) => !declared.includes(k)),
  ];
  const parts: string[] = [];
  for (const key of keys) {
    if (NOT_CONTENT.has(key)) continue;
    const val = entity.attributes[key];
    if (typeof val === "string" && val.trim()) parts.push(val.trim());
    else if (Array.isArray(val))
      parts.push(val.filter((v) => typeof v === "string").join(", "));
  }
  return parts;
}

/**
 * The record as a sentence: its type, what its attributes say, then the span it was extracted from.
 *
 * What the default key looks like is `fact {"statement":"...","external_id":"raw:00007-a.md#3"}` —
 * every attribute NAME is a token, so are the punctuation and the ids, and a three-word record is
 * indexed as mostly bookkeeping. That dilutes both halves of retrieval: BM25 pays for the length,
 * and the embedding is of a JSON literal rather than of a claim.
 *
 * `sources` stays, verbatim and last. LongMemEval's gain came from the expansion *plus* the original
 * value, not from the expansion alone, and this is the only attribute holding words the source
 * actually used.
 *
 * Falls back to the default key when `attributesJson` is not a JSON object, because an index that
 * throws on a malformed row is worse than one that indexes it verbatim.
 */
export function proseText(
  type: string,
  attributesJson: string,
  ontology: TypeDef[],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(attributesJson);
  } catch {
    return `${type} ${attributesJson}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return `${type} ${attributesJson}`;
  const attributes = parsed as Record<string, unknown>;
  const quote =
    typeof attributes.sources === "string" ? attributes.sources : "";
  return [
    type.replace(/_/g, " "),
    ...contentValues({ type, attributes }, ontology),
    quote,
  ]
    .filter((p) => p.trim())
    .join(". ");
}

/**
 * A fetch Embedder for OpenAI-compatible /embeddings endpoints.
 * Returns an always-null no-op when YOKE_EMBED_URL / YOKE_EMBED_MODEL are unset.
 * YOKE_EMBED_KEY, if present, is used for Bearer auth; if absent it is omitted (allowing keyless local endpoints).
 * No SDK — fetch is called directly.
 */
export function makeFetchEmbedder(env: Env): Embedder {
  const url = env.YOKE_EMBED_URL;
  const model = env.YOKE_EMBED_MODEL;
  // "prose" is the index-key selector `proseKeyEnabled` accepts here, not a token — sending
  // `Bearer prose` would 401 a keyed endpoint for a reason nobody would guess from the message.
  const key = env.YOKE_EMBED_KEY === "prose" ? undefined : env.YOKE_EMBED_KEY;
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
          `yoke: embedding request failed (${res.status}) — keyword retrieval only; duplicate detection skipped`,
        );
        return null;
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec)) {
        console.error(
          "yoke: embedding response malformed — keyword retrieval only; duplicate detection skipped",
        );
        return null;
      }
      return Float32Array.from(vec);
    } catch (e) {
      console.error(
        `yoke: embedding error (${(e as Error).message}) — keyword retrieval only; duplicate detection skipped`,
      );
      return null;
    }
  };
}

/**
 * The dimension-mismatch refusal, for every backend with a vector index.
 *
 * SPEC "The vector index" requires this failure to name both widths and the command that fixes it, on
 * reads and writes alike. Today its two vector-capable adapters (sqlite, opensearch) call this in four
 * places — two each, a read and a write. It was written because those clauses were
 * inlined per adapter and the wordings had already drifted: the write paths said "with the new
 * model", the read paths said "with the current model" and dropped the sentence explaining why a
 * database has one vector space. A message is not
 * backend behaviour, so one copy costs no coupling (invariant 2 is about behaviour) — and a person
 * hitting this on two different backends should not have to work out whether it is the same problem.
 *
 * `reading` picks the noun, which is the only thing that legitimately differs: a query has the wrong
 * width, or a vector being written does.
 */
export function dimensionMismatch(
  current: number,
  given: number,
  reading: boolean,
): Error {
  return new Error(
    `embedding dimension changed: the vector index holds ${current}-dimension vectors ` +
      `and this ${reading ? "query" : "one"} is ${given}. ` +
      "A database has one vector space — re-index every record with the new model: " +
      "yoke backfill --embeddings --rebuild",
  );
}
