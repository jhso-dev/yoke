"use client";

import { type Cited, citationLabel } from "../lib/citation";

/**
 * A record's source: shown compactly, copied in full.
 *
 * The authoritative citation is `[type:id@vN] actor, occurred_at` — built by core, pinned by its
 * tests, and made of two ULIDs. That is right for an audit pointer and wrong for anything a person
 * reads: it is ~50 characters of unreadable id.
 *
 * So EVERY screen shows the compact label and keeps the authoritative string one hover (title) or one
 * click (clipboard) away. There is no "verbatim here, compact there" exception — a raw ULID wall is
 * unreadable in a detail panel for the same reason it is unreadable in a table, and the copy
 * affordance serves the auditor better than text they would have to select by hand.
 */
export function Citation({ row }: { row: Cited }) {
  return (
    <span className="cite">
      <button
        type="button"
        className="cite"
        title={`${row.citation}\n\nclick to copy the full citation`}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "copy",
          font: "inherit",
          color: "inherit",
        }}
        onClick={() => navigator.clipboard?.writeText(row.citation)}
      >
        {citationLabel(row)}
      </button>
    </span>
  );
}
