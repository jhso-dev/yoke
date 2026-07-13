// meeting-notes connector (PLAN 8.5). Scans local .txt/.md transcripts and yields one draft fact per
// chunk. Chunking is a dumb heuristic (headings / blank-line paragraphs) by design — no NLP; humans
// promote what matters via review/verify. fs access is fine here: connectors are front-tier producers.
// external_id = file:<relpath>#<index> (index is the chunk position within the file).

import * as fs from "node:fs";
import { join } from "node:path";
import type { Connector } from "./types.js";

/** Split on markdown headings and blank lines; drop empty chunks. */
export function splitChunks(text: string): string[] {
  return text
    .split(/\n(?=#)|\n\s*\n/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Local transcript dir → draft fact connector. Recursive; files are visited in sorted path order. */
export function makeNotesConnector(opts: {
  dir: string;
  fsImpl?: Pick<typeof fs, "readdirSync" | "readFileSync">;
}): Connector {
  const f = opts.fsImpl ?? fs;
  return {
    name: "meeting-notes",
    async *pull() {
      const files = (
        f.readdirSync(opts.dir, {
          recursive: true,
          encoding: "utf8",
        }) as string[]
      )
        .filter((p) => /\.(txt|md)$/i.test(p))
        .sort();
      for (const rel of files) {
        const text = f.readFileSync(join(opts.dir, rel), "utf8");
        const chunks = splitChunks(text);
        for (let i = 0; i < chunks.length; i++) {
          const externalId = `file:${rel}#${i}`;
          yield {
            type: "fact",
            attributes: {
              statement: chunks[i],
              source_file: rel,
              external_id: externalId,
            },
            externalId,
          };
        }
      }
    },
  };
}
