"use client";

import { shortId } from "../lib/citation";

/**
 * Who recorded something, rendered for a human.
 *
 * `provenance.actor` is a person entity id or an agent identifier (core/types.ts), so on its own it
 * is usually a ULID — unreadable. The server resolves person ids to a name; this renders the name
 * and keeps the id reachable, because the id is what the citation points at and what an auditor
 * needs. Falls back to the id when there is no name (machine actors, deleted people).
 */
export function Actor({
  actor,
  actorName,
}: {
  actor: string;
  actorName?: string;
}) {
  // The name alone when we have one — a trailing id fragment is noise, not provenance. The full id
  // is in the title for anyone who needs it, and in the citation for anyone auditing.
  if (actorName !== undefined) return <span title={actor}>{actorName}</span>;
  // No person record behind this actor: show it, shortened if it is an opaque id rather than words.
  return (
    <span className="mono" title={actor}>
      {shortId(actor)}
    </span>
  );
}
