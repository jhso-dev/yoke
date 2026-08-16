// How a lifecycle status looks. Pure and exhaustive, so it is unit-testable and a new status cannot
// be added without the compiler pointing here.
//
// Every status carries a text label, never colour alone — colour-only encoding is unreadable to a
// meaningful share of users and this is an accessibility basic, not a simplification to skip.
//
// What lives here is the APPEARANCE (tone, glyph) and the stored name. What does not is the
// explanation: "staged but not verified — withheld from injection" is a sentence said to a person,
// so it lives in the locale catalogs as `t.status.meaning[…]`. An English literal here would show
// through on the Korean UI with no guard able to see it, because the untranslated test walks the
// catalogs.

import type { Status } from "./types";

export interface StatusStyle {
  /** The STORED value, untranslated on purpose: it is what the database and the CLI both say. */
  label: string;
  /** The Badge variant that draws this status (components/ui/badge.tsx). Typed rather than a
   * `data-tone` string, so a tone with no matching variant is a compile error. */
  tone: "draft" | "verified" | "stale" | "deprecated" | "unknown";
  /** A short glyph reinforcing the label for scanning. */
  glyph: string;
}

const STYLES: Record<Status, StatusStyle> = {
  draft: { label: "draft", tone: "draft", glyph: "○" },
  verified: { label: "verified", tone: "verified", glyph: "✓" },
  stale: { label: "stale", tone: "stale", glyph: "◌" },
  deprecated: { label: "deprecated", tone: "deprecated", glyph: "✕" },
};

/** The style for what to display: the read-time status, never the stored one. */
export function statusStyle(s: Status | string): StatusStyle {
  return (
    STYLES[s as Status] ?? { label: String(s), tone: "unknown", glyph: "?" }
  );
}
