"use client";

import Link from "next/link";
import { Checkbox } from "@/components/ui/checkbox";
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

/** The standard rendering of knowledge rows — type, summary, status, actor, source.
 *
 * Not the only one: screens with their own row shape (graph nodes, an entity's relations) render
 * their own tables. What holds "knowledge is always shown with its source and version" (WEB-UI.md)
 * across all of them is `citation-render.test.ts`, which fails any screen that shows a record
 * without a `<Citation>` — the non-optional `citation` field guarantees the DATA carries a source
 * and cannot make a screen render one. */
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
                  <Checkbox
                    // "Some of these are selected" is a VALUE here, not a DOM property poked into the
                    // node by a ref after render — which is what a native checkbox forced, since
                    // `indeterminate` has no attribute form.
                    checked={
                      head.indeterminate ? "indeterminate" : head.checked
                    }
                    onCheckedChange={() => {
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
                    <Checkbox
                      checked={select.chosen.has(r.id)}
                      onCheckedChange={() => select.toggle(r.id)}
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
