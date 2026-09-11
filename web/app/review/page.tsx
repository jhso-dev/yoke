"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Actor } from "../../components/Actor";
import { DeprecateButton } from "../../components/DeprecateButton";
import { Downstream } from "../../components/Downstream";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { Panel } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * The re-confirmation queue.
 *
 * Records here were live and then aged past their type's freshness window — and SPEC has said
 * since v1 that "viewing stale is the job of review/CLI" while nothing showed it, so stale
 * knowledge left injection with nobody told. A record vanishing from what agents receive,
 * silently, is the failure docs/RESEARCH.md's freshness findings converge on: flagging alone does
 * not fix anything, routing it to the person who recorded it does.
 *
 * Two acts, because the queue asks one question — is this still true? Re-confirm answers yes and
 * reopens the freshness window; Deprecate answers no and retires it with a reason.
 *
 * Delphi independence guard (carried over from the v2.5 design): this shows only the raw queue,
 * never other people's pending judgments. Seeing that a colleague already re-confirmed something
 * anchors your own judgment, so aggregation belongs AFTER each person commits, not before.
 */
export default function Review() {
  const t = useT();
  const stale = useAsync(() => api.review({ limit: 100 }), []);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [downstream, setDownstream] = useState<Knowledge[]>([]);

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  async function reconfirm() {
    setBusy(true);
    setActionError(null);
    try {
      await api.verify([...chosen]);
      setChosen(new Set());
      stale.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const rows = stale.data?.items ?? [];
  // First load only: a re-fetch after re-confirm/deprecate keeps the queue on screen rather than
  // replacing it with the word "loading" at the moment the reader is checking what changed.
  const loading = stale.loading && !stale.data;

  // Who to ask, most-owed first. This is the whole point of the queue: the fix for an aged-out
  // record is a person re-confirming it, so the screen names them instead of only counting rows.
  // Keyed by actor id — two people can share a display name, and the id is what the record stored.
  const owners = [
    ...rows
      .reduce(
        (m, r) =>
          m.set(r.actor, {
            name: r.actorName,
            n: (m.get(r.actor)?.n ?? 0) + 1,
          }),
        new Map<string, { name?: string; n: number }>(),
      )
      .entries(),
  ].sort((a, b) => b[1].n - a[1].n);

  return (
    <>
      <h1>{t.review.heading}</h1>
      <p className="lede">{t.review.lede}</p>
      <ErrorBanner
        error={stale.error ?? actionError}
        // Only the LOAD is retryable from here. A failed re-confirm/deprecate must not be re-fired
        // by a button that looks like a page reload — the reader re-presses the action they chose.
        onRetry={stale.error ? () => stale.reload() : undefined}
      />
      <div className="controls">
        <Button
          type="button"
          disabled={busy || chosen.size === 0}
          onClick={reconfirm}
          title={t.common.verifyHint}
        >
          {/* A pending label, like every form in this app. A bulk act on a hundred records looked
              identical to a dead button while it ran. */}
          {busy ? t.common.verifying : t.common.reconfirm} {chosen.size || ""}
        </Button>
        {/* Retiring names what rested on the batch (v5.8) and asks why — the queue is where the
            still-true question gets answered, so it is the last place that should drop either half. */}
        <DeprecateButton
          ids={[...chosen]}
          disabled={busy || chosen.size === 0}
          label={`${t.common.deprecate} ${chosen.size || ""}`.trim()}
          onDone={(down) => {
            setDownstream(down);
            setChosen(new Set());
            stale.reload();
          }}
        />
        <span className="muted">
          {t.review.staleScanned(rows.length, stale.data?.scanned ?? 0)}
        </span>
      </div>
      {/* Below the toolbar for the same reason as the entity screen: it is what pressing Deprecate did. */}
      <Downstream rows={downstream} />
      {/* The walk is bounded, so an unfinished scan is said in words rather than implied by a count. */}
      {stale.data?.next && <Alert variant="warn">{t.review.staleMore}</Alert>}
      {owners.length > 0 && (
        <Panel className="px-3.5 py-2.5">
          <p className="muted mb-2">{t.review.staleOwners}</p>
          {/* A grid, not a comma-joined sentence. Thirty owners rendered inline read as one paragraph
              of prose that happened to contain names — the reader has to parse it to find their own,
              which is the opposite of a work queue. Columns put the names in a scannable list and let
              the counts line up, which is the only reason the counts are worth showing per row. */}
          <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-1 p-0">
            {owners.map(([id, o]) => (
              <li
                key={id}
                className="flex items-baseline justify-between gap-2"
              >
                <Actor actor={id} actorName={o.name} />
                {/* Tabular figures so a column of counts aligns on the digit rather than the glyph. */}
                <span className="muted tabular-nums">
                  {t.review.staleOwnerCount(o.n)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel>
        {loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : (
          <KnowledgeTable
            rows={rows}
            empty={t.review.empty}
            paginate
            // The queue arrives most-consumed first (inject + persona audit rows naming the record),
            // so the trailing column says WHY this row is near the top: agents are still being fed it.
            trailing={{
              head: t.review.injectedHead,
              cell: (r) =>
                t.review.injectedTimes(
                  (r as Knowledge & { injections?: number }).injections ?? 0,
                ),
            }}
            select={{
              chosen,
              toggle,
              clear: () => setChosen(new Set()),
            }}
          />
        )}
      </Panel>
    </>
  );
}
