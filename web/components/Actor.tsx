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
  author,
  authorName,
}: {
  actor: string;
  actorName?: string;
  /** The WRITER, off the authored_by edge (injected/persona rows). When present it is who this
   * knowledge is from — shown instead of the promoter that `actor` names on a verified record. */
  author?: string;
  authorName?: string;
}) {
  // The writer wins when there is one: `actor` on a verified record is its promoter, and the column
  // asks who the knowledge is from. The promoter is not lost — it is in the citation, one cell over.
  const [who, name] = author ? [author, authorName] : [actor, actorName];
  // The name alone when we have one — a trailing id fragment is noise, not provenance. The full id
  // is in the title for anyone who needs it, and in the citation for anyone auditing.
  if (name !== undefined) return <span title={who}>{name}</span>;
  // No person record behind this actor: show it, shortened if it is an opaque id rather than words.
  return (
    <span className="mono" title={who}>
      {shortId(who)}
    </span>
  );
}
