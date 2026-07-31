"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination, usePage } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import { type ConflictPair, isMissing, type Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * Contradiction pairs, side by side.
 *
 * The only actions are deprecating one side or leaving both — never merge, never auto-resolve. A
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
            <span className="mono">{shortId(s.id)}</span> —{" "}
            {t.common.notInNamespace}
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
          <Button
            type="button"
            variant="destructive"
            disabled={busy === k.id || k.effectiveStatus === "deprecated"}
            onClick={() => retire(k.id)}
          >
            {k.effectiveStatus === "deprecated"
              ? t.conflicts.alreadyRetired
              : t.common.deprecate}
          </Button>
        </div>
      </div>
    );
  };

  const t = useT();
  const rows = pairs.data ?? [];
  const page = usePage(rows);
  return (
    <>
      <h1>{t.conflicts.heading}</h1>
      <p className="lede">{t.conflicts.lede}</p>
      <ErrorBanner error={pairs.error ?? actionError} />
      {pairs.loading ? (
        <div className="panel">
          <div className="empty">{t.common.loading}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="panel">
          <div className="empty">{t.conflicts.empty}</div>
        </div>
      ) : (
        <>
          {page.items.map((p) => (
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
                {/* Lucide rather than the ↔ character: a glyph renders at whatever weight the
                  system font happens to give it, which is how this arrived hairline-thin and
                  invisible. An icon is a path, so it is the same on every machine.
                  `aria-hidden` because the panel head already says `conflicts_with` in text. */}
                <ArrowLeftRightIcon
                  aria-hidden="true"
                  size={24}
                  style={{
                    alignSelf: "center",
                    color: "var(--muted-foreground)",
                  }}
                />
                {side(p.to)}
              </div>
            </div>
          ))}
          <Pagination
            page={page.page}
            pages={page.pages}
            setPage={page.setPage}
            total={rows.length}
          />
        </>
      )}
    </>
  );
}
