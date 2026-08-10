"use client";

import { Alert } from "@/components/ui/alert";
import { useT } from "../lib/i18n";
import type { Knowledge } from "../lib/types";
import { KnowledgeTable } from "./KnowledgeTable";

/**
 * What rested on a record that was just deprecated (`derived_from`, v5.8).
 *
 * Retiring a record is not a repair unless the records built on it can be found — the stale queue's
 * rule one surface over. So this appears at the moment of retiring, which is the one moment someone is
 * looking, and it names each record instead of counting them: "3 records" routes nobody.
 *
 * The heading is an Alert and the records go through `KnowledgeTable`, which is not a layout preference:
 * a governed decision's summary runs to 60 characters, so labels joined inline render as one unreadable
 * paragraph — and a hand-rolled list is a list without citations, which WEB-UI.md forbids ("knowledge is
 * always shown with its source and version"). One component, both problems.
 *
 * Every deprecate button in the app renders this, so no screen can be the surface that quietly drops
 * the answer.
 */
export function Downstream({ rows }: { rows: Knowledge[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <>
      <Alert variant="warn">{t.common.downstream(rows.length)}</Alert>
      {/* Its own bottom margin, which no other `.panel` carries: the convention in globals.css is
          `.panel + .panel`, i.e. panels arrive in a run and the gap lives on the following one. This
          panel appears mid-page next to controls, so nothing supplies that gap and the table butted
          straight into the Verify/Deprecate buttons. Adjacent margins collapse to the max, so a panel
          after this one still sits 14px away rather than 28. */}
      <div className="panel mb-[14px]">
        {/* `empty` is unreachable here (the guard above returns on an empty list) but required, so
            the last caller relying on an English default is gone. */}
        <KnowledgeTable rows={rows} empty={t.common.none} />
      </div>
    </>
  );
}
