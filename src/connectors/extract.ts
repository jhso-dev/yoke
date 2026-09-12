// LLM extraction: raw text → EntityInput candidates. A connector turns a source into records; this is
// the same job for a source whose records are not separated yet. Slack and meeting-notes can point at
// a row boundary (a message, a heading) and chunk on it; a work transcript carries knowledge with no
// boundary to point at, so a model has to say where the records are.
//
// It is a front-tier producer like every other connector piece — it proposes, and everything it
// proposes goes through the commit gate as a draft. Nothing here can write.
//
// The contract mirrors Embedder (core/embedding.ts) on purpose: env-configured, OpenAI-compatible,
// no SDK, and null rather than a throw when unavailable. An unconfigured extractor degrades to
// "extracted nothing", never to a crashed ingest.

import type { TypeDef } from "../core/ontology.js";

/** One proposed record, plus the span of source text it rests on. */
export interface Extracted {
  type: string;
  attributes: Record<string, unknown>;
  /** Verbatim span from the source. The connector files it as provenance; `quoted` enforces it. */
  quote: string;
}

/** text → proposed records. null = unavailable (unconfigured or failed), which reads as "none". */
export type Extractor = (text: string) => Promise<Extracted[] | null>;

type Env = Record<string, string | undefined>;

/**
 * The types an extractor may propose: entity types the ontology does not mark `structural`.
 *
 * Read straight from the ontology rather than listed here, because the ontology is data — an org that
 * renames `fact` or adds `incident` gets it extracted with no code change. `structural` is exactly the
 * right filter and already carries this meaning: those types NAME something knowledge attaches to (a
 * person, a piece of work) instead of being something someone recorded as true. A model asked to
 * extract knowledge from a transcript would otherwise happily file "we have a project called yoke" as
 * a collaboration, which is structure the corpus already has.
 */
export function extractableTypes(ontology: TypeDef[]): TypeDef[] {
  return ontology.filter((t) => t.kind === "entity" && !t.structural);
}

/** The type menu handed to the model — name, attributes, and which of them are required. */
export function typeMenu(ontology: TypeDef[]): string {
  return extractableTypes(ontology)
    .map((t) => {
      const attrs = Object.entries(t.attrs)
        .map(([k, s]) => `${k}: ${s.type}${s.required ? " (required)" : ""}`)
        .join(", ");
      return `- ${t.name} — ${attrs || "no declared attributes"}`;
    })
    .join("\n");
}

/**
 * Why rule 6 exists, and why `quoted` below enforces it rather than trusting it: an extractor's
 * failure mode is not silence, it is a fluent record nobody said. Requiring a verbatim span makes the
 * claim checkable in code, and a model that cannot find the span usually could not have found the
 * knowledge either.
 */
export function systemPrompt(ontology: TypeDef[]): string {
  return `You extract durable knowledge from a raw work transcript into records.

Record types available. Use only these types, and only these attributes:
${typeMenu(ontology)}

Rules:
1. Extract only what the transcript states. Never infer, generalise, or add anything that is not
   there. If nothing qualifies, return [].
2. Each record must stand alone. Someone who never saw this transcript must understand it with no
   further context. Never write "the above", "this file", "as discussed", "the user asked".
3. One record per distinct thing worth remembering. Do not merge several claims into a summary, and
   do not skip one because it resembles another you already wrote. Skip only what carries no claim:
   greetings and chitchat, tool output, and restatements of what the code already says.
4. Extract what someone would need to know later — a decision and the reason for it, what a person
   prefers or avoids, what was tried and what came of it, a term used here in a particular way, a
   constraint discovered the hard way. Record something that was later reversed as well: that a
   position changed is itself worth knowing, and the record carries the date it was said.
5. Write each record in the language the transcript uses.
6. quote: copy a verbatim span of the transcript that this record rests on — copied exactly,
   character for character, not paraphrased. If you cannot quote it, do not extract it.

Return a JSON array and nothing else. No prose, no code fence:
[{"type": "...", "attributes": {...}, "quote": "..."}]`;
}

/**
 * The form a quote is compared in: whitespace collapsed, markdown emphasis dropped.
 *
 * Both are cases of the model reproducing the words and not the typography, which is not the thing
 * being checked — the claim is that somebody said this, and `` `compact` `` versus `compact` is not a
 * different claim. Reflowing came first; the emphasis rule was added on measurement, when a 26B local
 * model over this repo's own transcripts returned four parseable quotes of which three matched only
 * after stripping backticks and asterisks. The fourth had elided its middle with an ellipsis and is
 * still dropped, which is the line: normalising away formatting is not the same as tolerating a gap.
 */
const normalize = (s: string): string =>
  s
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Drop every proposal whose quote is not actually in the source, and everything malformed.
 *
 * The gate revalidates all of this (unknown type, missing required attribute), so this is not
 * validation — it is the one check the gate cannot make, because only the caller still has the source
 * text to compare against.
 */
export function keepGrounded(
  items: unknown,
  source: string,
  ontology: TypeDef[],
): Extracted[] {
  if (!Array.isArray(items)) return [];
  const allowed = new Set(extractableTypes(ontology).map((t) => t.name));
  const hay = normalize(source);
  const out: Extracted[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const { type, attributes, quote } = raw as Record<string, unknown>;
    if (typeof type !== "string" || !allowed.has(type)) continue;
    if (typeof attributes !== "object" || attributes === null) continue;
    if (Array.isArray(attributes)) continue;
    if (typeof quote !== "string" || quote.trim() === "") continue;
    if (!hay.includes(normalize(quote))) continue;
    out.push({
      type,
      attributes: attributes as Record<string, unknown>,
      quote,
    });
  }
  return out;
}

/**
 * The top-level `{…}` spans in a JSON array body, as raw text.
 *
 * Brace depth, tracking string literals so a brace inside one does not move it. When a broken string
 * desyncs that tracking the spans after it are wrong, which is exactly the record being dropped
 * anyway — the salvage below parses each span on its own, so a wrong one costs itself.
 */
function objectSpans(body: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * Pull the proposed records out of a model response. Fences and a sentence of preamble are the two
 * things every OpenAI-compatible endpoint does regardless of instruction, so they are handled rather
 * than treated as failures.
 *
 * **One malformed record must not cost the others.** `JSON.parse` on the whole array is
 * all-or-nothing, and the way a model breaks this format is an unescaped quote inside one string —
 * measured on a 26B local model over Korean material, which returned five well-formed records and
 * one `"conclusion": "번역 규칙을 "사람에게…"로 수정함."`, and the array parse discarded all six. That
 * is minutes of local inference thrown away over one record, reported as "added 0".
 *
 * So: parse the array (the fast path, and correct whenever the model behaved), and only on failure
 * fall back to parsing each top-level object alone and keeping the ones that survive. The result is
 * an array either way, and `keepGrounded` — which is already per-item tolerant — decides the rest.
 */
export function parseItems(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? content;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  const array = body.slice(start, end + 1);
  try {
    return JSON.parse(array);
  } catch {
    const salvaged: unknown[] = [];
    for (const span of objectSpans(array)) {
      try {
        salvaged.push(JSON.parse(span));
      } catch {
        /* this record only */
      }
    }
    return salvaged.length > 0 ? salvaged : null;
  }
}

/**
 * How long to wait for the model, in ms — the whole call, not the gap between bytes.
 *
 * Ten minutes, because a local model is routinely slower than a hosted one: measured, a 14k-character
 * transcript through a 26B model on a LAN box took 2m31s, and a 39k one did not finish inside five
 * minutes. Configurable via YOKE_LLM_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * How many times one chunk is offered to the model before it is given up on, and the first backoff.
 *
 * A failed call is not a chunk with nothing in it, it is a chunk nobody read — and since a document
 * is extracted in pieces, one dropped call is a hole in the middle of what gets filed, invisible
 * afterwards because the records that would have named it are the ones missing. Measured: an
 * endpoint on a LAN box went off the network and came back twice within one run.
 *
 * Three is the number that covers a restart without turning a genuinely dead endpoint into a long
 * wait: with a 2s base the whole sequence gives up after six seconds of retrying. Set
 * YOKE_LLM_RETRIES=0 to fail on the first error. The base is operational too — a box coming back up
 * and a rate-limited hosted API want different waits — via YOKE_LLM_RETRY_BASE_MS.
 */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 2_000;

/**
 * Concatenate the assistant text out of an OpenAI-compatible SSE stream.
 * Returns null when the stream carried no content at all — the caller reports that as malformed.
 *
 * Tolerant by construction: a `data:` line that does not parse is skipped rather than fatal, because
 * one bad frame should cost its own tokens and not the completion. `[DONE]` ends it; so does the
 * stream closing, which is what a server that forgets the sentinel does.
 */
async function readStream(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    // The last element is whatever arrived without its newline yet; keep it for the next chunk.
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return out === "" ? null : out;
      try {
        const frame = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const piece = frame.choices?.[0]?.delta?.content;
        if (typeof piece === "string") out += piece;
      } catch {
        /* this frame only */
      }
    }
  }
  return out === "" ? null : out;
}

/**
 * One model call returning a JSON array, or null.
 *
 * For OpenAI-compatible /chat/completions endpoints. `YOKE_LLM_KEY`, if present, is used for Bearer
 * auth; absent it is omitted (keyless local endpoints). `YOKE_LLM_TIMEOUT_MS` overrides the wait.
 * No SDK — fetch is called directly. Returns null when `YOKE_LLM_URL`/`YOKE_LLM_MODEL` are unset,
 * which is how a caller decides whether to refuse or degrade.
 *
 * Shared with `relate.ts` rather than copied: everything below the prompt is the same problem twice
 * — the streaming workaround, the timeout that names its knob, the retry that keeps a transient
 * failure from reading as "nothing found", and the salvage for a model that breaks one string. A
 * second copy of that would drift, and the half that drifted would be the half nobody measured.
 *
 * `null` means the call did not happen or could not be read. An empty array means the model answered
 * and found nothing — the caller has to tell those apart.
 */
export function makeJsonCaller(
  env: Env,
  what: string,
): ((system: string, user: string) => Promise<unknown[] | null>) | null {
  const url = env.YOKE_LLM_URL;
  const model = env.YOKE_LLM_MODEL;
  const key = env.YOKE_LLM_KEY;
  if (!url || !model) return null;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key) headers.authorization = `Bearer ${key}`;
  const timeoutMs =
    Number(env.YOKE_LLM_TIMEOUT_MS) > 0
      ? Number(env.YOKE_LLM_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  const attempts =
    Number(env.YOKE_LLM_RETRIES) >= 0
      ? Number(env.YOKE_LLM_RETRIES) + 1
      : DEFAULT_ATTEMPTS;
  const retryBaseMs =
    Number(env.YOKE_LLM_RETRY_BASE_MS) >= 0
      ? Number(env.YOKE_LLM_RETRY_BASE_MS)
      : DEFAULT_RETRY_BASE_MS;

  const once = async (
    system: string,
    text: string,
  ): Promise<unknown[] | null> => {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model,
          temperature: 0,
          // Streamed, and not for progress: Node's fetch enforces its own 300s headersTimeout —
          // time to the FIRST header — which `AbortSignal.timeout` does not override and no public
          // Node API exposes. A non-streaming endpoint sends no header until the whole completion is
          // built, so any call slower than five minutes died as `fetch failed` no matter what
          // YOKE_LLM_TIMEOUT_MS said. Measured: a 39k-character document through a 26B model on a
          // LAN box hits that ceiling. Streaming makes the server send headers at once and the body
          // arrive continuously, so the only limit left is the one above, which is ours.
          stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: text },
          ],
        }),
      });
      if (!res.ok) {
        console.error(
          `yoke: ${what} request failed (${res.status}) — nothing came back`,
        );
        return null;
      }
      const content = await readStream(res);
      if (content === null) {
        console.error(`yoke: ${what} response malformed — nothing came back`);
        return null;
      }
      const items = parseItems(content);
      return Array.isArray(items) ? items : null;
    } catch (e) {
      // A timeout arrives as a TimeoutError whose message says only "operation was aborted", so it
      // gets the sentence that names what to change instead.
      const err = e as Error;
      console.error(
        err.name === "TimeoutError"
          ? `yoke: ${what} timed out after ${timeoutMs}ms — nothing came back. ` +
              "A slower model or a longer document needs a bigger YOKE_LLM_TIMEOUT_MS."
          : `yoke: ${what} error (${err.message}) — nothing came back`,
      );
      return null;
    }
  };

  return async (system: string, text: string): Promise<unknown[] | null> => {
    for (let attempt = 1; ; attempt++) {
      const got = await once(system, text);
      if (got !== null || attempt >= attempts) return got;
      const wait = retryBaseMs * 2 ** (attempt - 1);
      console.error(
        `yoke: retrying this ${what} call in ${wait}ms (attempt ${attempt + 1} of ${attempts})`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  };
}

/**
 * A fetch Extractor for OpenAI-compatible /chat/completions endpoints.
 * Returns an always-null no-op when YOKE_LLM_URL / YOKE_LLM_MODEL are unset.
 * YOKE_LLM_KEY, if present, is used for Bearer auth; absent it is omitted (keyless local endpoints).
 * YOKE_LLM_TIMEOUT_MS overrides the wait. No SDK — fetch is called directly.
 */
export function makeFetchExtractor(env: Env, ontology: TypeDef[]): Extractor {
  const call = makeJsonCaller(env, "extraction");
  if (!call) return async () => null;
  const system = systemPrompt(ontology);
  return async (text: string): Promise<Extracted[] | null> => {
    const items = await call(system, text);
    return items === null ? null : keepGrounded(items, text, ontology);
  };
}
