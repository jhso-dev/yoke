// How a lifecycle status looks. Pure and exhaustive, so it is unit-testable and a new status cannot
// be added without the compiler pointing here.
//
// Every status carries a text label, never colour alone — colour-only encoding is unreadable to a
// meaningful share of users and this is an accessibility basic, not a simplification to skip.

import type { Status } from "./types";

export interface StatusStyle {
  label: string;
  /** The Badge variant that draws this status (components/ui/badge.tsx). Was a `data-tone` attribute
   * selecting a CSS rule; typed now, so a tone with no matching variant is a compile error. */
  tone: "draft" | "verified" | "stale" | "deprecated" | "unknown";
  /** A short glyph reinforcing the label for scanning. */
  glyph: string;
  title: string;
}

const STYLES: Record<Status, StatusStyle> = {
  draft: {
    label: "draft",
    tone: "draft",
    glyph: "○",
    title: "staged but not verified — withheld from injection",
  },
  verified: {
    label: "verified",
    tone: "verified",
    glyph: "✓",
    title: "a human promoted this; agents may receive it",
  },
  stale: {
    label: "stale",
    tone: "stale",
    glyph: "◌",
    title: "past its type's TTL — withheld until someone re-confirms it",
  },
  deprecated: {
    label: "deprecated",
    tone: "deprecated",
    glyph: "✕",
    title: "retired; never injected",
  },
};

/** The style for what to display: the read-time status, never the stored one. */
export function statusStyle(s: Status | string): StatusStyle {
  return (
    STYLES[s as Status] ?? {
      label: String(s),
      tone: "unknown",
      glyph: "?",
      title: "unrecognized status",
    }
  );
}

/** True when an agent could actually receive this record right now. */
export function isInjectable(s: Status | string): boolean {
  return s === "verified";
}
