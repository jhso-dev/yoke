"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "../lib/i18n";
import { statusStyle } from "../lib/status";
import type { Status } from "../lib/types";

/** A record's lifecycle state: colour, label and glyph together — never colour alone.
 *
 * `tone` names a Badge variant one-for-one (see components/ui/badge.tsx), which is what the
 * `data-tone` attribute used to select in CSS. Keeping the mapping in lib/status.ts means a new status
 * still cannot be added without the compiler pointing at it. */
export function StatusBadge({ status }: { status: Status | string }) {
  const t = useT();
  const s = statusStyle(status);
  // Keyed by TONE, not by the raw status string: an unrecognized status maps to `unknown`, which is
  // the one case that has no name of its own to look up.
  const meaning = t.status.meaning[s.tone];
  return (
    <Badge variant={s.tone} title={meaning}>
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
    </Badge>
  );
}
