"use client";

import { Badge } from "@/components/ui/badge";
import { statusStyle } from "../lib/status";
import type { Status } from "../lib/types";

/** A record's lifecycle state: colour, label and glyph together — never colour alone.
 *
 * `tone` names a Badge variant one-for-one (see components/ui/badge.tsx), which is what the
 * `data-tone` attribute used to select in CSS. Keeping the mapping in lib/status.ts means a new status
 * still cannot be added without the compiler pointing at it. */
export function StatusBadge({ status }: { status: Status | string }) {
  const s = statusStyle(status);
  return (
    <Badge variant={s.tone} title={s.title}>
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
    </Badge>
  );
}
