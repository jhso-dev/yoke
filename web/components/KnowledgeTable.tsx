"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { recordLabel } from "../lib/citation";
import { useT } from "../lib/i18n";
import { headerCheckState } from "../lib/selection";
import type { Knowledge } from "../lib/types";
import { Actor } from "./Actor";
import { Citation } from "./Citation";
import { Pagination, usePage } from "./Pagination";
import { StatusBadge } from "./StatusBadge";

/** The one component that renders knowledge rows.
 *
 * Every screen goes through it, which is how "knowledge is always shown with its source and
 * version" (WEB-UI.md) stays true without anyone remembering to do it: the Knowledge type makes
 * citation non-optional, so a row without one does not compile. */
export function KnowledgeTable({
  rows,
  empty = "nothing here",
  paginate = false,
  select,
}: {
  rows: Knowledge[];
  empty?: string;
  paginate?: boolean;
  /** When given, renders a checkbox column for bulk governance actions. */
  select?: {
    chosen: Set<string>;
    toggle: (id: string) => void;
    /** Select or clear every row currently in the table — the header checkbox. */
    setAll: (next: boolean) => void;
  };
}) {
  const t = useT();
  const paged = usePage(rows);
  const visible = paginate ? paged.items : rows;
  // Counted against the rows on screen, not `chosen.size`: the header must describe THIS table, and
  // a selection made before a filter narrowed it would otherwise show as "all".
  const here = select
    ? visible.filter((r) => select.chosen.has(r.id)).length
    : 0;
  const head = headerCheckState(visible.length, here);
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <>
      <div className="scroll-x">
        <Table>
          <TableHeader>
            <TableRow>
              {select && (
                <TableHead>
                  <input
                    type="checkbox"
                    checked={head.checked}
                    // A DOM property with no attribute form, so it is set on the node itself.
                    ref={(el) => {
                      if (el) el.indeterminate = head.indeterminate;
                    }}
                    onChange={() => {
                      const next = head.checked
                        ? visible
                        : visible.filter((r) => !select.chosen.has(r.id));
                      for (const r of next) select.toggle(r.id);
                    }}
                    aria-label={t.review.selectAll}
                    title={t.review.selectAll}
                  />
                </TableHead>
              )}
              <TableHead>{t.common.type}</TableHead>
              <TableHead>{t.chrome.summary}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead>{t.common.actor}</TableHead>
              <TableHead>{t.common.source}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow key={r.id}>
                {select && (
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={select.chosen.has(r.id)}
                      onChange={() => select.toggle(r.id)}
                      aria-label={`select ${r.id}`}
                    />
                  </TableCell>
                )}
                <TableCell className="mono">{r.type}</TableCell>
                <TableCell>
                  <Link href={`/entity/?id=${encodeURIComponent(r.id)}`}>
                    {recordLabel(r)}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.effectiveStatus} />
                </TableCell>
                <TableCell>
                  <Actor actor={r.actor} actorName={r.actorName} />
                </TableCell>
                <TableCell>
                  <Citation row={r} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {paginate && (
        <Pagination
          page={paged.page}
          pages={paged.pages}
          setPage={paged.setPage}
          total={rows.length}
        />
      )}
    </>
  );
}
