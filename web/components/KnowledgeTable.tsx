"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
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
import type { InjectedKnowledge, Knowledge } from "../lib/types";
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
  empty,
  paginate = false,
  select,
  trailing,
}: {
  rows: Knowledge[];
  /** Required: a default here is an English literal that a call site can silently rely on. */
  empty: string;
  paginate?: boolean;
  /** When given, renders a checkbox column for bulk governance actions. */
  select?: {
    chosen: Set<string>;
    toggle: (id: string) => void;
    /** Drop the whole selection. Called when the page turns — see the effect below. */
    clear: () => void;
  };
  /** One optional extra column at the end, for a queue-specific signal (the stale queue's
   * consumption count). A prop rather than a fork of this table, so the citation guard keeps
   * covering every screen that renders knowledge rows. */
  trailing?: {
    head: string;
    cell: (r: Knowledge) => React.ReactNode;
  };
}) {
  const t = useT();
  const paged = usePage(rows);
  const visible = paginate ? paged.items : rows;
  // A selection belongs to the page it was made on, and is dropped when the page turns. Surviving
  // the turn would leave the toolbar reading "Deprecate 20" with not one visible row checked, and
  // pressing it would retire twenty records the reader cannot see. Bulk work wider than a page is
  // what the CLI is for.
  const clearSelection = select?.clear;
  const shownPage = useRef(paged.page);
  useEffect(() => {
    if (shownPage.current === paged.page) return;
    shownPage.current = paged.page;
    clearSelection?.();
  }, [paged.page, clearSelection]);
  // Counted against the rows on screen, not `chosen.size`: the header must describe THIS table, and
  // a selection made before a filter narrowed it would otherwise show as "all".
  const here = select
    ? visible.filter((r) => select.chosen.has(r.id)).length
    : 0;
  const head = headerCheckState(visible.length, here);
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <>
      {/* No outer scroll wrapper: `Table` renders its own `overflow-x-auto` container, and a second
          one around it cannot scroll (its only child is `w-full`) — it only nests two scrollers. */}
      <Table>
        <TableHeader>
          <TableRow>
            {select && (
              <TableHead>
                <Checkbox
                  // "Some of these are selected" is a VALUE here, not a DOM property poked into the
                  // node by a ref after render — which is what a native checkbox forces, since
                  // `indeterminate` has no attribute form.
                  checked={head.indeterminate ? "indeterminate" : head.checked}
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
            {trailing && <TableHead>{trailing.head}</TableHead>}
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
                    // The record's own label, never its id: this prop IS the human surface for a
                    // screen-reader user, and an id here reads out a 26-character ULID on every one
                    // of twenty rows while the visible cell two columns over says the summary. The
                    // no-raw-ids guard cannot see it (prop position, and the id arrives through a
                    // template), so it is a rule the reviewer has to hold.
                    aria-label={t.review.selectRow(recordLabel(r))}
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
                {/* An injected/persona row carries the writer off the authored_by edge; plain rows
                    do not, so `author` is undefined and <Actor> shows the recorded actor as before. */}
                <Actor
                  actor={r.actor}
                  actorName={r.actorName}
                  author={(r as InjectedKnowledge).author}
                  authorName={(r as InjectedKnowledge).authorName}
                />
              </TableCell>
              <TableCell>
                <Citation row={r} />
              </TableCell>
              {trailing && <TableCell>{trailing.cell(r)}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
