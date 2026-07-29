"use client";

import { useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
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
  return (
    <>
      <h1>Review queue</h1>
      <p className="lede">
        Everything staged and not yet believed. Nothing here reaches an agent:
        drafts are withheld from injection until a human promotes them.
      </p>
      <ErrorBanner error={drafts.error ?? actionError} />
      <div className="controls">
        <button
          type="button"
          className="primary"
          disabled={busy || chosen.size === 0}
          onClick={() => act("verify")}
        >
          verify {chosen.size || ""}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || chosen.size === 0}
          onClick={() => act("deprecate")}
        >
          deprecate {chosen.size || ""}
        </button>
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={() => setChosen(new Set(rows.map((r) => r.id)))}
        >
          select all
        </button>
        <span className="muted">{rows.length} draft(s)</span>
      </div>
      <div className="panel">
        {drafts.loading ? (
          <div className="empty">loading…</div>
        ) : (
          <KnowledgeTable
            rows={rows}
            empty="no drafts — the queue is clear"
            select={{ chosen, toggle }}
          />
        )}
      </div>
    </>
  );
}
