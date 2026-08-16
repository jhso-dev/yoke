// How a record's source is labelled for a human.
//
// Split out of the component so it is assertable without a browser. This project has twice shipped a
// display defect that every test passed: v2.5's client script never parsed, and v5.0 rendered raw
// ULIDs in the actor and source columns. Both were invisible to assertions over API payloads, because
// the payloads were correct — the rendering was not. A pure function is the smallest thing that can
// fail when the label regresses.

import type { Knowledge } from "./types";

/** The fields a citation label needs. Narrower than Knowledge so a graph node can pass too.
 * `author`/`authorName` are optional (only injected/persona rows carry them) and, when present, name
 * the writer rather than the promoter — see `citationLabel`. */
export type Cited = Pick<
  Knowledge,
  "type" | "version" | "actor" | "actorName" | "occurred_at" | "citation"
> & { author?: string; authorName?: string };

/**
 * The compact, readable rendering of a record's source: `fact@v2 · Bora · 2026-07-30`.
 *
 * This is NOT the citation, and is never parsed out of it — the authoritative string stays available
 * verbatim (title + clipboard) so the audit pointer is never lost. Built from structured fields
 * instead, so the label and the citation cannot drift into disagreeing.
 *
 * The date is sliced from the ISO string rather than formatted: no locale, no timezone shift, and it
 * matches the ISO vocabulary the CLI already prints.
 */
export function citationLabel(row: Cited): string {
  // The writer when one is known, never falling through to the promoter: on a verified record
  // `actor` is whoever approved it, and a label that named them would be the drift this exists to
  // remove. Without an author edge the promoter is the only actor there is.
  const who = row.author
    ? (row.authorName ?? shortId(row.author))
    : (row.actorName ?? shortId(row.actor));
  return [
    `${row.type}@v${row.version}`,
    who,
    row.occurred_at.slice(0, 10),
  ].join(" · ");
}

/** A machine actor stays as-is (it is already words); an unresolved id is truncated, not hidden. */
export function shortId(actor: string): string {
  return actor.includes(":") || actor.length <= 10
    ? actor
    : `${actor.slice(0, 8)}…`;
}

/**
 * What to call a record on screen.
 *
 * `summary` is the first string attribute, so it is empty for a record whose attributes hold no
 * text — and every screen used to fall back to `summary || id`, which put a bare ULID in the one
 * cell a person reads for meaning. The type plus a short id at least says WHAT the thing is; the
 * full id stays in the link target and the citation.
 */
export function recordLabel(row: {
  id: string;
  type: string;
  summary?: string;
}): string {
  return row.summary || `${row.type} ${shortId(row.id)}`;
}
