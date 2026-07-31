"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useAsync } from "../../lib/useAsync";

/**
 * The draft queue — the screen WEB-UI.md calls the core one, because promotion friction is what
 * decides whether governance actually happens.
 *
 * Delphi independence guard (carried over from the v2.5 design): this shows only the raw draft list,
 * never other reviewers' pending approvals. Seeing that a colleague already approved something
 * anchors your own judgment, so aggregation belongs AFTER each reviewer commits, not before. There is
 * deliberately no endpoint exposing peers' pending decisions, and there must not be one.
 */
export default function Review() {
  const t = useT();
  const drafts = useAsync(() => api.review(), []);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  async function act(kind: "verify" | "deprecate") {
    setBusy(true);
    setActionError(null);
    try {
      const ids = [...chosen];
      await (kind === "verify" ? api.verify(ids) : api.deprecate(ids));
      setChosen(new Set());
      drafts.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const rows = drafts.data ?? [];

  // The header checkbox. Over the rows on screen rather than every draft, so it keeps meaning the
  // moment this queue grows a filter.
  const setAll = (next: boolean) =>
    setChosen(next ? new Set(rows.map((r) => r.id)) : new Set());
  return (
    <>
      <h1>{t.review.heading}</h1>
      <p className="lede">{t.review.lede}</p>
      <ErrorBanner error={drafts.error ?? actionError} />
      <div className="controls">
        <Button
          type="button"
          disabled={busy || chosen.size === 0}
          onClick={() => act("verify")}
        >
          {t.common.verify} {chosen.size || ""}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy || chosen.size === 0}
          onClick={() => act("deprecate")}
        >
          {t.common.deprecate} {chosen.size || ""}
        </Button>
        <span className="muted">{t.review.draftCount(rows.length)}</span>
      </div>
      <div className="panel">
        {drafts.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : (
          <KnowledgeTable
            rows={rows}
            empty={t.review.empty}
            paginate
            select={{ chosen, toggle, setAll }}
          />
        )}
      </div>
    </>
  );
}
