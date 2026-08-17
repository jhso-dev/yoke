// adr connector (v7.1.4). Architecture Decision Records already written as files → draft `decision`
// records, with the document's own date rather than the import clock.
//
// Why this connector and not `notes`: a `notes` chunk becomes a `fact` (a statement), and an ADR is a
// `decision` (a conclusion, its rationale, and what was turned down). Filing ADRs as facts loses the
// rejected alternatives, which VISION calls half of the judgment and is the raw material a persona
// stands on. An organisation adopting yoke usually has years of these on disk; this is the cheapest
// dense source of decisions there is, and it needs no credential.
//
// Parsing is deliberately shallow — the standard headings and nothing else. An ADR that does not use
// them yields its conclusion from the title and its rationale from the body, which is still a decision
// with provenance rather than a parse failure.

import * as fs from "node:fs";
import { join } from "node:path";
import type { Connector, SourceItem } from "./types.js";

/** `## Decision`, `### Context`, `Status:` — the headings MADR and Nygard-style ADRs share. */
const SECTION = /^\s{0,3}#{1,4}\s*([A-Za-z][A-Za-z \-/]*?)\s*$/;

/** Split a markdown document into `heading (lowercased) -> body`. Text before the first heading is "". */
export function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body)
      out.set(
        current,
        (out.get(current) ? `${out.get(current)}\n` : "") + body,
      );
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const m = line.match(SECTION);
    if (m) {
      flush();
      current = m[1].trim().toLowerCase();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

/** The `sections` key the document's first heading produced, or "" when it has none. */
function firstHeading(text: string): string {
  for (const line of text.split("\n")) {
    const m = line.match(SECTION);
    if (m) return m[1].trim().toLowerCase();
  }
  return "";
}

/** The first heading of the document, which is an ADR's title by convention. */
function titleOf(text: string, fallback: string): string {
  for (const line of text.split("\n")) {
    const m = line.match(/^\s{0,3}#\s+(.*\S)\s*$/);
    if (m) return m[1].replace(/^ADR[- ]?\d+[:.]?\s*/i, "").trim();
  }
  return fallback;
}

/**
 * A date the document states about itself, in ISO form, or undefined.
 *
 * Read from a `Date:` line or a `YYYY-MM-DD` in the filename — the two places an ADR actually carries
 * one. NOT the file mtime: that is when someone last touched the file, and a repo checkout gives every
 * ADR the same clone timestamp, which would make a decade of decisions expire on the same day. Absent
 * means the source does not say, and `ingest` falls back to the import clock, honestly labelled.
 */
export function statedDate(text: string, filename: string): string | undefined {
  const line = text.match(
    /^\s*(?:[-*]\s*)?(?:\*\*)?date(?:\*\*)?\s*[:=]\s*(\S+)/im,
  );
  const raw = line?.[1] ?? filename.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!raw) return undefined;
  const day = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!day) return undefined;
  const iso = `${day[1]}-${day[2]}-${day[3]}T00:00:00.000Z`;
  // Round-tripped so `2026-02-30` is rejected rather than silently moved to March — the same rule the
  // gate's instant validator applies, checked here so a bad date does not become a record's whole life.
  return new Date(iso).toISOString() === iso ? iso : undefined;
}

/** `Rejected alternatives` / `Considered options` / `Alternatives`, one per list item. */
function rejected(map: Map<string, string>): string[] {
  const body =
    map.get("rejected alternatives") ??
    map.get("alternatives considered") ??
    map.get("considered options") ??
    map.get("alternatives") ??
    "";
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/** ADR files → draft decision connector. Recursive; files are visited in sorted path order. */
export function makeAdrConnector(opts: { dir: string }): Connector {
  return {
    name: "adr",
    async *pull(): AsyncIterable<SourceItem> {
      const files = (
        fs.readdirSync(opts.dir, {
          recursive: true,
          encoding: "utf8",
        }) as string[]
      )
        .filter((p) => /\.(md|markdown)$/i.test(p))
        .sort();
      for (const rel of files) {
        const text = fs.readFileSync(join(opts.dir, rel), "utf8");
        const map = sections(text);
        const title = titleOf(text, rel);
        // The Decision section is the conclusion; without one the title is, because an ADR's title is
        // conventionally the decision itself ("Use Postgres for the event store").
        const conclusion = (map.get("decision") ?? title).trim();
        if (!conclusion) continue;
        // A document with no standard headings keeps its prose under the TITLE heading, so reading only
        // the named sections files the placeholder rationale and silently drops the body — measured on a
        // Nygard-era ADR that had a title and two paragraphs. The title's own section, then the text
        // before any heading, are the last two places the reasoning can be.
        const rationale = (
          map.get("rationale") ??
          map.get("context") ??
          map.get("context and problem statement") ??
          map.get("consequences") ??
          map.get(firstHeading(text)) ??
          map.get("") ??
          ""
        ).trim();
        const alternatives = rejected(map);
        // One record per file, keyed by path. An ADR is one decision by construction, so unlike a
        // transcript there is no chunk index and no position drift when the document is edited.
        const externalId = `adr:${rel}`;
        yield {
          type: "decision",
          attributes: {
            conclusion,
            // The gate requires a rationale on `decision`. A document with no context section still has
            // its own text, and citing the file beats refusing an ADR that a human clearly wrote.
            rationale: rationale || `Recorded in ${rel}`,
            ...(alternatives.length
              ? { rejected_alternatives: alternatives }
              : {}),
            source_file: rel,
            external_id: externalId,
          },
          externalId,
          occurredAt: statedDate(text, rel),
        };
      }
    },
  };
}
