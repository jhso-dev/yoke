"use client";

import Link from "next/link";
import { recordLabel } from "../lib/citation";
import type { Knowledge } from "../lib/types";
import { Actor } from "./Actor";
import { Citation } from "./Citation";
import { StatusBadge } from "./StatusBadge";

/** The one component that renders knowledge rows.
 *
 * Every screen goes through it, which is how "knowledge is always shown with its source and
 * version" (WEB-UI.md) stays true without anyone remembering to do it: the Knowledge type makes
 * citation non-optional, so a row without one does not compile. */
export function KnowledgeTable({
  rows,
  empty = "nothing here",
  select,
}: {
  rows: Knowledge[];
  empty?: string;
  /** When given, renders a checkbox column for bulk governance actions. */
  select?: { chosen: Set<string>; toggle: (id: string) => void };
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            {select && <th aria-label="select" />}
            <th>type</th>
            <th>summary</th>
            <th>status</th>
            <th>actor</th>
            <th>source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {select && (
                <td>
                  <input
                    type="checkbox"
                    checked={select.chosen.has(r.id)}
                    onChange={() => select.toggle(r.id)}
                    aria-label={`select ${r.id}`}
                  />
                </td>
              )}
              <td className="mono">{r.type}</td>
              <td>
                <Link href={`/entity/?id=${encodeURIComponent(r.id)}`}>
                  {recordLabel(r)}
                </Link>
              </td>
              <td>
                <StatusBadge status={r.effectiveStatus} />
              </td>
              <td>
                <Actor actor={r.actor} actorName={r.actorName} />
              </td>
              <td>
                <Citation row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
