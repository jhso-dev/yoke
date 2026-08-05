"use client";

import { Button } from "@/components/ui/button";
import { type Cited, citationLabel } from "../lib/citation";
import { copyText } from "../lib/clipboard";
import { useT } from "../lib/i18n";

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
  const t = useT();
  return (
    <span className="cite">
      <Button
        variant="ghost"
        size="text"
        className="cite cursor-copy"
        title={`${row.citation}\n\n${t.common.copyFull}`}
        onClick={() => copyText(row.citation, t.common.copied)}
      >
        {citationLabel(row)}
      </Button>
    </span>
  );
}
