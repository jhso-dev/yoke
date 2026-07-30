"use client";

import Link from "next/link";
import { useState } from "react";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { type ConflictPair, isMissing, type Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * Contradiction pairs, side by side.
 *
 * The only actions are "deprecate this side" or leave both — never merge, never auto-resolve. A
 * disagreement is itself knowledge (KNOWLEDGE-POLICY), so coexisting is a legitimate outcome and the
 * screen says so instead of pressuring a decision.
 */
export default function Conflicts() {
  const pairs = useAsync(() => api.conflicts(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  async function retire(id: string) {
    setBusy(id);
    setActionError(null);
    try {
      await api.deprecate([id]);
      pairs.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  const side = (s: ConflictPair["from"]) => {
    if (isMissing(s))
      return (
        <div className="panel" style={{ padding: 12 }}>
          <span className="muted">
            <span className="mono">{shortId(s.id)}</span> — not in this
            namespace
          </span>
        </div>
      );
    const k = s as Knowledge;
    return (
      <div className="panel" style={{ padding: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusBadge status={k.effectiveStatus} />
          <span className="mono muted">{k.type}</span>
        </div>
        <p style={{ margin: "8px 0" }}>
          <Link href={`/entity/?id=${encodeURIComponent(k.id)}`}>
            {recordLabel(k)}
          </Link>
        </p>
        <Citation row={k} />
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="danger"
            disabled={busy === k.id || k.effectiveStatus === "deprecated"}
            onClick={() => retire(k.id)}
          >
            {k.effectiveStatus === "deprecated"
              ? "already retired"
              : "deprecate this side"}
          </button>
        </div>
      </div>
    );
  };

  const rows = pairs.data ?? [];
  return (
    <>
      <h1>Conflicts</h1>
      <p className="lede">
        Verified records that contradict each other. yoke keeps both and never
        picks a winner — deprecate one side, or leave them coexisting, which is
        a real answer when the disagreement is the knowledge.
      </p>
      <ErrorBanner error={pairs.error ?? actionError} />
      {pairs.loading ? (
        <div className="panel">
          <div className="empty">loading…</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel">
          <div className="empty">no contradictions recorded</div>
        </div>
      ) : (
        rows.map((p) => (
          <div key={p.id} className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head">
              <span className="mono">conflicts_with</span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                gap: 10,
                alignItems: "start",
                padding: 12,
              }}
            >
              {side(p.from)}
              <div
                className="muted mono"
                style={{ alignSelf: "center", padding: "0 4px" }}
              >
                ↔
              </div>
              {side(p.to)}
            </div>
          </div>
        ))
      )}
    </>
  );
}
