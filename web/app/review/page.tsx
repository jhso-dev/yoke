"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
 * The two governance queues, one screen.
 *
 * Drafts were never trusted. Stale records were verified and then aged past their type's freshness
 * window — and SPEC has said since v1 that "viewing stale is the job of review/CLI" while neither
 * showed one, so stale knowledge left injection with nobody told. A record vanishing from what agents
 * receive, silently, is the failure docs/RESEARCH.md's freshness findings converge on: flagging alone
 * does not fix anything, routing it to the person who recorded it does.
 *
 * Same two buttons in both tabs, because both queues take the same two acts — but `verify` MEANS
 * something different in each (first promotion vs re-confirmation), which is why these are tabs and
 * not one merged list.
 *
 * Delphi independence guard (carried over from the v2.5 design): this shows only the raw queues, never
 * other reviewers' pending approvals. Seeing that a colleague already approved something anchors your
 * own judgment, so aggregation belongs AFTER each reviewer commits, not before. There is deliberately
 * no endpoint exposing peers' pending decisions, and there must not be one.
 *
 * The queue lives in the URL (`?queue=stale`), like every other filter in this app. Not consistency
 * for its own sake: this screen's whole purpose is getting an aged-out record in front of the person
 * who recorded it, and a tab held in component state cannot be sent to them.
 */
function ReviewBody() {
  const t = useT();
  const params = useSearchParams();
  const router = useRouter();
  const tab: "drafts" | "stale" =
    params.get("queue") === "stale" ? "stale" : "drafts";
  const drafts = useAsync(() => api.review(), []);
  // Fetched independently of the tab so the counts on both tabs are real before you click either one —
  // a queue you cannot see the size of is a queue you forget exists, which is how staleness got here.
  const stale = useAsync(() => api.stale({ limit: 100 }), []);
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

  async function act(kind: "verify" | "deprecate") {
    setBusy(true);
    setActionError(null);
    try {
      const ids = [...chosen];
      if (kind === "verify") await api.verify(ids);
      else setDownstream((await api.deprecate(ids)).downstream);
      setChosen(new Set());
      // Both queues: verifying a draft can only remove it from drafts, but re-confirming a stale
      // record removes it from stale, and a deprecate acts on whichever list you were looking at.
      // Reloading one would leave the other showing a row that no longer belongs in it.
      drafts.reload();
      stale.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  const staleRows = stale.data?.items ?? [];
  const rows = tab === "drafts" ? (drafts.data ?? []) : staleRows;
  // First load only: a re-fetch after verify/deprecate keeps the queue on screen rather than
  // replacing it with the word "loading" at the moment the reader is checking what changed.
  const loading =
    tab === "drafts"
      ? drafts.loading && !drafts.data
      : stale.loading && !stale.data;

  // Who to ask, most-owed first. This is the whole point of the stale tab: the fix for an aged-out
  // record is a person re-confirming it, so the screen names them instead of only counting rows.
  // Keyed by actor id — two people can share a display name, and the id is what the record stored.
  const owners = [
    ...staleRows
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

  const switchTo = (next: "drafts" | "stale") => {
    // Selection is per queue: carrying ids across would let a Verify aimed at drafts land on stale
    // records the reader is no longer looking at.
    setChosen(new Set());
    // `replace`, not `push` — flipping a tab is not a navigation step someone wants to walk back
    // through, and the audit and browse screens make the same choice for their filters.
    router.replace(next === "stale" ? "/review/?queue=stale" : "/review/");
  };

  return (
    <>
      <h1>{t.review.heading}</h1>
      <p className="lede">
        {tab === "drafts" ? t.review.lede : t.review.staleLede}
      </p>
      <ErrorBanner
        error={drafts.error ?? stale.error ?? actionError}
        // Only the LOAD is retryable from here. A failed verify/deprecate must not be re-fired by a
        // button that looks like a page reload — the reader re-presses the action they chose.
        onRetry={
          drafts.error || stale.error
            ? () => {
                drafts.reload();
                stale.reload();
              }
            : undefined
        }
      />
      <div className="controls">
        {/* Radios, not buttons: this is one choice between two states, and a radio group is what a
            screen reader announces as such without any aria bookkeeping. Radix supplies the roles and
            the arrow-key handling, so the segments ARE the options — no native inputs hidden
            off-screen behind styled labels. */}
        <RadioGroup
          value={tab}
          onValueChange={(v) => switchTo(v as "drafts" | "stale")}
          aria-label={t.nav.review}
          className="inline-flex gap-0 overflow-hidden rounded-[var(--radius)] border border-border"
        >
          {(["drafts", "stale"] as const).map((k) => (
            <RadioGroupItem
              key={k}
              value={k}
              className="inline-flex aspect-auto size-auto items-center gap-1.5 rounded-none border-0 border-l border-border bg-background px-2.5 py-0 h-7 text-[13px] text-muted-foreground shadow-none first:border-l-0 focus-visible:ring-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-[state=checked]:bg-secondary data-[state=checked]:font-medium data-[state=checked]:text-foreground dark:bg-background"
            >
              {k === "drafts" ? t.review.tabDrafts : t.review.tabStale}
              <span className="muted">
                {k === "drafts" ? (drafts.data?.length ?? 0) : staleRows.length}
              </span>
            </RadioGroupItem>
          ))}
        </RadioGroup>
        {/* Same act, different word — and the vocabulary already existed: the entity detail screen has
            relabelled this "Re-confirm" for a stale record since it shipped. Calling it Verify in the
            aged-out queue would say "promote this" about a record that was already promoted. */}
        <Button
          type="button"
          disabled={busy || chosen.size === 0}
          onClick={() => act("verify")}
          title={t.common.verifyHint}
        >
          {/* A pending label, like every form in this app. A bulk deprecate of a hundred records
              looked identical to a dead button while it ran. */}
          {busy
            ? t.common.verifying
            : tab === "stale"
              ? t.common.reconfirm
              : t.common.verify}{" "}
          {chosen.size || ""}
        </Button>
        {/* Retiring names what rested on the batch (v5.8) and now asks why — the queue is where
            governance happens, so it is the last place that should drop either half. */}
        <DeprecateButton
          ids={[...chosen]}
          disabled={busy || chosen.size === 0}
          label={`${t.common.deprecate} ${chosen.size || ""}`.trim()}
          onDone={(down) => {
            setDownstream(down);
            setChosen(new Set());
            drafts.reload();
            stale.reload();
          }}
        />
        <span className="muted">
          {tab === "drafts"
            ? t.review.draftCount(rows.length)
            : t.review.staleScanned(rows.length, stale.data?.scanned ?? 0)}
        </span>
      </div>
      {/* Below the toolbar for the same reason as the entity screen: it is what pressing Deprecate did. */}
      <Downstream rows={downstream} />
      {/* The walk is bounded, so an unfinished scan is said in words rather than implied by a count. */}
      {tab === "stale" && stale.data?.next && (
        <Alert variant="warn">{t.review.staleMore}</Alert>
      )}
      {tab === "stale" && owners.length > 0 && (
        <Panel className="px-3.5 py-2.5">
          <p className="muted mb-2">{t.review.staleOwners}</p>
          {/* A grid, not a comma-joined sentence. Thirty owners rendered inline read as one paragraph of
              prose that happened to contain names — the reader has to parse it to find their own, which
              is the opposite of a work queue. Columns put the names in a scannable list and let the
              counts line up, which is the only reason the counts are worth showing per row at all. */}
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
            empty={tab === "drafts" ? t.review.empty : t.review.staleEmpty}
            paginate
            // The stale queue arrives most-consumed first (inject + persona audit rows naming the
            // record), so the trailing column says WHY this row is near the top: agents are still
            // being fed it. Drafts have no such signal — nothing injects a draft by default.
            trailing={
              tab === "stale"
                ? {
                    head: t.review.injectedHead,
                    cell: (r) =>
                      t.review.injectedTimes(
                        (r as Knowledge & { injections?: number }).injections ??
                          0,
                      ),
                  }
                : undefined
            }
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

export default function Review() {
  // `useSearchParams` needs a Suspense boundary under static export, the same as the inject screen.
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <ReviewBody />
    </Suspense>
  );
}
