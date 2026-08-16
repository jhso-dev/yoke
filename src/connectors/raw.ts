// raw connector: point it at unstructured material and a model proposes records from it.
//
// The other connectors know their source — a Slack channel, a PR, a table. This one is defined by
// the OPPOSITE: it makes no claim about where the material came from, only that it is text nobody has
// turned into records yet. A conversation log, a design doc, a postmortem, an exported thread.
//
// Why it is not just `notes`: the difference is the method, and the method follows from whether the
// source has a record boundary to point at. `notes` cuts on a heading and files each chunk verbatim —
// free, exact, and right when the material is already written as statements. Here there is no
// boundary worth cutting on, and filing verbatim would file the process rather than what was learned,
// so a model has to say where the records are. Both stay: one costs nothing and invents nothing, the
// other costs a call per file and needs its output reviewed.
//
// fs access is fine here: connectors are front-tier producers.
// external_id = raw:<relpath>#<index> (index is the record's position within that file).

import * as fs from "node:fs";
import { extname, join } from "node:path";
import type { Extractor } from "./extract.js";
import type { Connector } from "./types.js";

/** How many extraction calls were made and how many never reached the model. See `stats` below. */
export type ExtractStats = { calls: number; failures: number };

/** What a transcript record has to look like for us to read it. Everything else is skipped. */
type Line = {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
};

/**
 * A JSONL agent transcript, as conversation text — user and assistant prose only.
 *
 * A transcript is mostly not conversation, and dropping the rest is not only cost. Tool results are
 * file dumps, so a model handed them extracts the FILE, and a `thinking` block is a model's own
 * draft reasoning — filing that as something a person recorded is the impersonation this corpus
 * exists to prevent. Sidechains (subagent turns) go for the same reason: nobody said them to anybody.
 *
 * Shaped after the Claude Code transcript, and tolerant rather than strict — an unreadable line is
 * skipped, so a format that disagrees degrades to "less text" instead of an error. A format that
 * shares nothing with this one renders empty, which the caller reports rather than files.
 */
export function renderTranscript(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let rec: Line;
    try {
      rec = JSON.parse(line) as Line;
    } catch {
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (rec.isSidechain) continue;
    const content = rec.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: string; text: string } =>
                  typeof b === "object" &&
                  b !== null &&
                  (b as { type?: unknown }).type === "text" &&
                  typeof (b as { text?: unknown }).text === "string",
              )
              .map((b) => b.text)
              .join("\n")
          : "";
    if (text.trim()) out.push(`${rec.type}: ${text.trim()}`);
  }
  return out.join("\n\n");
}

/** The newest timestamp in a transcript. Undefined when it carries none. */
export function lastTimestamp(jsonl: string): string | undefined {
  let latest: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ts = (JSON.parse(line) as Line).timestamp;
      if (typeof ts === "string" && (latest === undefined || ts > latest))
        latest = ts;
    } catch {
      /* not a record we can read */
    }
  }
  return latest;
}

/** Which extensions this connector will read. Anything else in the directory is left alone. */
const READABLE = /\.(jsonl|md|txt|markdown|text|log)$/i;

/**
 * File contents → the text handed to the model.
 *
 * One dispatch, on extension, because that is the only thing that differs: a `.jsonl` is a stream of
 * records that has to be rendered before it reads as prose, and everything else already is prose.
 * A new format is a case here, not a new connector.
 */
export function toText(rel: string, contents: string): string {
  return extname(rel).toLowerCase() === ".jsonl"
    ? renderTranscript(contents)
    : contents;
}

/**
 * When this file last changed, for `--since`. A transcript carries its own timestamps and they are
 * better than the filesystem's — copying a session forward would otherwise make it look new — so they
 * win where they exist, and mtime is the fallback for material that carries none.
 */
export function sourceTime(
  rel: string,
  contents: string,
  mtime: Date,
): string | undefined {
  if (extname(rel).toLowerCase() === ".jsonl") {
    const ts = lastTimestamp(contents);
    if (ts !== undefined) return ts;
  }
  return mtime.toISOString();
}

/**
 * How much source text goes into one extraction call, and how much of it repeats from the call
 * before.
 *
 * A long document in one call is not a cost problem, it is a RECALL problem: a model handed the
 * whole thing summarises it instead of enumerating it.
 *
 * The overlap exists because a claim that straddles a boundary belongs to neither side. It costs one
 * duplicate proposal per boundary, which `dedupeByQuote` below removes.
 *
 * The right chunk size depends on the model, and the way to find it is to measure —
 * YOKE_EXTRACT_CHUNK_CHARS overrides.
 */
const DEFAULT_CHUNK_CHARS = 6_000;
const OVERLAP_CHARS = 600;

/**
 * ceiling: a file is capped at this many chunks — 40 chunks is 240k characters, and beyond it the
 * bill deserves a decision rather than a default. What is dropped is announced, because a silent
 * truncation reads as "we read the whole thing".
 */
const MAX_CHUNKS = 40;

/** How far one window starts past the last. Shared with the truncation check, which has to know
 * exactly how far the windows reached and cannot restate this arithmetic without drifting from it. */
const stepOf = (size: number, overlap = OVERLAP_CHARS): number =>
  Math.max(1, size - overlap);

/** Split into overlapping windows. One window when the text already fits. */
export function chunkText(
  text: string,
  size = DEFAULT_CHUNK_CHARS,
  overlap = OVERLAP_CHARS,
): string[] {
  if (text.length <= size) return [text];
  const step = stepOf(size, overlap);
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < MAX_CHUNKS; i += step) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/**
 * How many chunks of one file are extracted at once.
 *
 * The chunks of a file are independent — each is grounded against itself and nothing downstream
 * reads them in order — so they go out together. Four is a floor on politeness rather than a tuned
 * number: an endpoint serving one model has a queue, and past a handful of requests the wait moves
 * into it instead of disappearing. YOKE_EXTRACT_CONCURRENCY overrides.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Map with a bounded number in flight, results in input order.
 *
 * Order matters even though the calls do not: `dedupeByQuote` keeps the FIRST proposal of a quote,
 * so a run whose results arrive in completion order would file a different record for the same file
 * on a second run. Two extractions of one file should differ because the model differed, not
 * because the network did.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Drop proposals whose quote was already proposed for this file. The overlap makes duplicates
 * expected: a claim inside the repeated span is offered by both neighbours. Compared on the quote
 * and not on the attributes, because the quote is the one field the model was told to copy rather
 * than compose — two windows paraphrase a statement differently and cite the same sentence.
 */
export function dedupeByQuote<T extends { quote: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.quote.replace(/\s+/g, " ").trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * A directory of raw material → extracted draft records. Recursive; files are visited in sorted path
 * order. `since` compares against each file's own time, which is what makes a re-run cheap: skipping
 * happens before the model is called, whereas ingest's external_id check happens after.
 *
 * @param limit stop after this many files have been read — a cost guard, since each one is a call.
 */
export function makeRawConnector(opts: {
  dir: string;
  extract: Extractor;
  limit?: number;
  /** Source characters per extraction call. Defaults to DEFAULT_CHUNK_CHARS; see its comment. */
  chunkChars?: number;
  /** Chunks extracted at once. Defaults to DEFAULT_CONCURRENCY; see its comment. */
  concurrency?: number;
  /**
   * Filled in as the pull runs, for a caller that has to tell two different zeroes apart.
   *
   * "The model proposed nothing" and "no call reached the model" both yield no records, and the
   * second is an outage. Measured: an endpoint went off the network mid-run and every file reported
   * `added 0, skipped 0` and exited 0, so the job carried on filing nothing for twenty minutes.
   */
  stats?: ExtractStats;
}): Connector {
  return {
    name: "raw",
    async *pull(since?: string) {
      const files = (
        fs.readdirSync(opts.dir, {
          recursive: true,
          encoding: "utf8",
        }) as string[]
      )
        .filter((p) => READABLE.test(p))
        .sort();
      let read = 0;
      for (const rel of files) {
        if (opts.limit !== undefined && read >= opts.limit) return;
        const path = join(opts.dir, rel);
        // A directory can match the extension filter, and a recursive listing includes it.
        if (!fs.statSync(path).isFile()) continue;
        const contents = fs.readFileSync(path, "utf8");
        if (since !== undefined) {
          const at = sourceTime(rel, contents, fs.statSync(path).mtime);
          if (at !== undefined && at <= since) continue;
        }
        const text = toText(rel, contents);
        if (!text.trim()) continue;
        // What the source says about when this was said. It was already computed for `--since`; not
        // passing it on left every record of a run stamped with the ingest clock instead.
        const occurredAt = sourceTime(rel, contents, fs.statSync(path).mtime);
        read++;
        const chunks = chunkText(text, opts.chunkChars);
        // Windows STEP by size − overlap, so what they reached is not chunks × size: counting it
        // that way overstates the coverage by the overlap on every boundary and a file inside that
        // band is truncated with no warning at all.
        const size = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
        const covered = (chunks.length - 1) * stepOf(size) + size;
        if (chunks.length === MAX_CHUNKS && covered < text.length)
          console.error(
            `yoke: ${rel} is ${text.length} characters and was read to the ${MAX_CHUNKS}-chunk cap — the tail was not extracted`,
          );
        // Each chunk is grounded against ITSELF inside the extractor, which is what makes the
        // per-chunk quote check meaningful: a model cannot cite a span it was never shown.
        const conc = opts.concurrency ?? DEFAULT_CONCURRENCY;
        const per = await mapPool(chunks, conc, opts.extract);
        // One deferred re-offer of the chunks nobody read. The in-call retry ladder (extract.ts)
        // cannot fill this hole: a burst outage takes out every socket in flight at once, so all
        // workers burn their backoff against the same dead network and exhaust together. Deferring
        // to the end of the file buys minutes of unrelated work as the wait, which the ladder cannot
        // buy at any setting. Free when nothing failed, and it re-offers only what failed.
        const dead = per.flatMap((r, i) => (r === null ? [i] : []));
        if (dead.length > 0) {
          console.error(
            `yoke: ${rel} — ${dead.length} of ${chunks.length} chunks were not read; offering them again`,
          );
          const again = await mapPool(dead, conc, (i) =>
            opts.extract(chunks[i]),
          );
          dead.forEach((i, j) => {
            per[i] = again[j];
          });
        }
        // `calls` stays one per chunk and `failures` counts what is STILL unread, so a re-offer
        // does not dilute the "every call failed" ratio the CLI refuses on.
        if (opts.stats) {
          opts.stats.calls += per.length;
          opts.stats.failures += per.filter((r) => r === null).length;
        }
        const items = dedupeByQuote(per.flatMap((r) => r ?? []));
        for (let i = 0; i < items.length; i++) {
          const externalId = `raw:${rel}#${i}`;
          const item = items[i];
          yield {
            occurredAt,
            type: item.type,
            attributes: {
              ...item.attributes,
              // The span this record rests on, kept beside it: a reviewer deciding whether to verify
              // is deciding whether the record matches what was actually said, and without the quote
              // that means opening the source and searching it.
              sources: `raw:${rel} — "${item.quote}"`,
              external_id: externalId,
            },
            externalId,
          };
        }
      }
    },
  };
}
