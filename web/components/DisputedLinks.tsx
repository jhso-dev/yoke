"use client";

import Link from "next/link";
import { recordLabel, shortId } from "../lib/citation";
import type { Knowledge } from "../lib/types";

/**
 * The records an injected row is recorded as contradicting, each NAMED.
 *
 * The server sends ids only, and N links that all read "contradicted by" and differ only in a ULID
 * tooltip are unreadable the moment a record disputes more than one. Both sides of a `conflicts_with`
 * are injected together (policy: surface, never resolve), so the contradicted record is almost always
 * already on screen: it is resolved from the rows the caller already loaded, and falls back to a
 * short id when it was filtered out (stale, withheld) rather than repeating a fixed phrase.
 *
 * Its own citation lives on its own row in the same table — this is a cross-reference link, so it is
 * exempt from citation-render.test.ts for the LinkRecord reason.
 */
export function DisputedLinks({
  ids,
  rows,
}: {
  ids?: string[];
  /** The rows already loaded on this screen, so the contradicted record can be named without a fetch. */
  rows: Knowledge[];
}) {
  if (!ids || ids.length === 0) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (
    <span className="flex flex-wrap gap-2">
      {ids.map((id) => {
        const hit = byId.get(id);
        return (
          <Link
            key={id}
            href={`/entity/?id=${encodeURIComponent(id)}`}
            title={id}
          >
            {hit ? recordLabel(hit) : shortId(id)}
          </Link>
        );
      })}
    </span>
  );
}
