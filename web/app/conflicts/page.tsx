"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Citation } from "../../components/Citation";
import { Downstream } from "../../components/Downstream";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel, PanelHead } from "../../components/Panel";
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
  const [downstream, setDownstream] = useState<Knowledge[]>([]);

  async function retire(id: string) {
    setBusy(id);
    setActionError(null);
    try {
      // Resolving a contradiction is a deprecate, so it owes the same answer (v5.8): a decision that
      // rested on the side you just retired is exactly what someone needs to look at next.
      setDownstream((await api.deprecate([id])).downstream);
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
        <Card className="gap-0 p-3">
          <span className="muted">
            <span className="mono">{shortId(s.id)}</span> —{" "}
            {t.common.notInNamespace}
          </span>
        </Card>
      );
    const k = s as Knowledge;
    const retired = k.effectiveStatus === "deprecated";
    return (
      <Card className="gap-0 p-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={k.effectiveStatus} />
          <span className="mono muted">{k.type}</span>
        </div>
        {/* min-w-0 so a long summary wraps instead of forcing the grid column wider than the
            viewport — the citation below used to be clipped mid-string with no ellipsis. */}
        <p className="my-2 min-w-0 break-words">
          <Link href={`/entity/?id=${encodeURIComponent(k.id)}`}>
            {recordLabel(k)}
          </Link>
        </p>
        <Citation row={k} />
        <div className="mt-2.5">
          {/* Disabled while ANY retire is in flight, not just this side's. Per-side it left the other
              button live, so two quick clicks retired both halves of a contradiction — the one
              outcome this screen exists to prevent. */}
          <Button
            type="button"
            variant="destructive"
            disabled={busy !== null || retired}
            onClick={() => retire(k.id)}
          >
            {retired
              ? t.conflicts.alreadyRetired
              : busy === k.id
                ? t.common.deprecating
                : t.common.deprecate}
          </Button>
        </div>
      </Card>
    );
  };

  const t = useT();
  const all = pairs.data ?? [];
  // Resolved pairs sink to the bottom instead of sitting in the queue forever. `/api/conflicts`
  // returns every `conflicts_with` relation whatever its sides' status, so a contradiction someone
  // settled last month kept its place in the list, interleaved with live ones and counted in the
  // same pager — a work queue that only grows. They are still LISTED, because the relation is
  // knowledge in its own right and hiding it would rewrite the record.
  const settled = (p: ConflictPair) =>
    [p.from, p.to].some(
      (s) => !isMissing(s) && (s as Knowledge).effectiveStatus === "deprecated",
    );
  const open = all.filter((p) => !settled(p));
  const rows = [...open, ...all.filter(settled)];
  const page = usePage(rows);
  return (
    <>
      <h1>{t.conflicts.heading}</h1>
      <p className="lede">{t.conflicts.lede}</p>
      <ErrorBanner
        error={pairs.error ?? actionError}
        onRetry={pairs.error ? pairs.reload : undefined}
      />
      <Downstream rows={downstream} />
      {pairs.loading ? (
        <Panel>
          <div className="empty">{t.common.loading}</div>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <div className="empty">{t.conflicts.empty}</div>
        </Panel>
      ) : (
        <>
          {open.length === 0 && (
            <Alert variant="info">{t.conflicts.allSettled}</Alert>
          )}
          {page.items.map((p) => (
            <Panel key={p.id} className="mb-[14px]">
              <PanelHead>
                <span className="mono">conflicts_with</span>
                {settled(p) && (
                  <span className="muted">{t.conflicts.settledNote}</span>
                )}
              </PanelHead>
              {/* One column on a phone, three from 48rem up. As a fixed `1fr auto 1fr` each side got
                  about 115px of content box at phone width, which clipped the citation mid-string —
                  and the source is the one thing this product never drops. */}
              <div className="grid items-start gap-2.5 p-3 md:grid-cols-[1fr_auto_1fr]">
                {side(p.from)}
                {/* Lucide rather than the ↔ character: a glyph renders at whatever weight the
                  system font happens to give it, which is how this arrived hairline-thin and
                  invisible. An icon is a path, so it is the same on every machine.
                  `aria-hidden` because the panel head already says `conflicts_with` in text. */}
                <ArrowLeftRightIcon
                  aria-hidden="true"
                  size={24}
                  className="self-center justify-self-center text-muted-foreground md:rotate-0 rotate-90"
                />
                {side(p.to)}
              </div>
            </Panel>
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
