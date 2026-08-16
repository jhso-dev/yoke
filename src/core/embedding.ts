// Embedding provider client (SPEC Embedder contract, PLAN 4.1).
// core receives an Embedder function by injection — the fetch implementation lives here, while tests use a deterministic stub.
// An embedding failure never blocks a commit (returns null → warning only; RETRIEVAL falls back to
// FTS, duplicate detection is skipped — SPEC "Stage 3 has no FTS fallback").

import type { TypeDef } from "./ontology.js";

/** text → embedding vector. null = unavailable (unconfigured or failed): retrieval falls back to
 * FTS; the commit gate skips duplicate detection rather than approximating it. */
export type Embedder = (text: string) => Promise<Float32Array | null>;

type Env = Record<string, string | undefined>;

/**
 * Attributes that are bookkeeping rather than what a record says, so they are kept out of the
 * SENTENCE. Three of them are dropped outright; `sources` and the two `IDENTIFIERS` are re-appended
 * verbatim at the end of the key — see `serializeText`.
 */
const NOT_CONTENT = new Set([
  "external_id",
  "sources",
  "author",
  "topic",
  "key",
  "status",
]);

/** Bookkeeping that is nonetheless SEARCHED FOR, exactly. See the tail of `serializeText`. */
const IDENTIFIERS = ["external_id", "key"] as const;

/**
 * The values a record's attributes carry, in declared-ontology order, bookkeeping dropped.
 *
 * Declared order, not written order, for the reason `summarize` gives: what a type declares FIRST is
 * what it wants read, and attribute order as written is caller-controlled. Undeclared attributes
 * follow, in written order.
 *
 * Private: `serializeText` below is the only caller. `persona.knowledgeText` and `display.summarize`
 * ask a similar question of a record and answer it their own way — see the ceiling on
 * `knowledgeText`.
 */
function contentValues(
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
 * The text that FTS and embeddings index: the record as a sentence — its type, what its attributes
 * say, the span it was extracted from, then the identifiers.
 *
 * The adapter (FTS) and core (commit) must share this rule so the two halves of one hybrid index see
 * the same representation. It lives in core and the adapter imports it (only adapter→core is
 * allowed — core importing the adapter would violate the dependency-direction invariant).
 *
 * It used to be `type + the attributes JSON`: `fact {"statement":"...","external_id":"raw:7-a.md#3"}`
 * — every attribute NAME a token, so are the punctuation and the ids, and a three-word record
 * indexed as mostly bookkeeping. That dilutes both halves of retrieval: BM25 pays for the length,
 * and the embedding is of a JSON literal rather than of a claim.
 *
 * `sources` stays, verbatim and last: the measured gain came from the prose expansion *plus* the
 * original value, not from the expansion alone, and this is the only attribute holding words the
 * source actually used.
 *
 * `ontology` is optional because the FTS callers are storage adapters, which are constructed with a
 * path and have no ontology in hand. It only affects the ORDER of the values, and FTS ranks a bag of
 * words, so the halves still see the same key.
 *
 * Falls back to `type + the raw text` when `attributesJson` is not a JSON object, because an index
 * that throws on a malformed row is worse than one that indexes it verbatim.
 */
export function serializeText(
  type: string,
  attributesJson: string,
  ontology: TypeDef[] = [],
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
    // The identifiers, last and verbatim — not prose, but they must stay IN the index because they
    // are looked up through it: `connectors/ingest.findByExternalId` (every connector's idempotency
    // check) and `mcp.resolveScope` both retrieve candidates by searching for the literal string and
    // then match exactly. Dropped from the key, a re-ingest finds nothing and stores a second copy of
    // every record — silently, since each write is individually valid.
    ...IDENTIFIERS.map((k) =>
      typeof attributes[k] === "string" ? (attributes[k] as string) : "",
    ),
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
 * reads and writes alike. Its two vector-capable adapters (sqlite, opensearch) call this in four
 * places — two each, a read and a write. A message is not backend behaviour, so one copy costs no
 * coupling (invariant 2 is about behaviour) — and a person hitting this on two different backends should
 * not have to work out whether it is the same problem.
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
