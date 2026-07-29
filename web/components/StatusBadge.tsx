"use client";

import { statusStyle } from "../lib/status";
import type { Status } from "../lib/types";

/** A record's lifecycle state: colour, label and glyph together — never colour alone. */
export function StatusBadge({ status }: { status: Status | string }) {
  const s = statusStyle(status);
  return (
    <span className="pill" data-tone={s.tone} title={s.title}>
      <span aria-hidden="true">{s.glyph}</span>
      {s.label}
    </span>
  );
}
