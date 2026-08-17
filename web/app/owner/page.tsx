"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, CardTitle } from "@/components/ui/card";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import type { Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * What one person or group is on the hook for — the routing screen for the weekly sweep and the expiry
 * ritual (ADOPTION.md §4).
 *
 * Their drafts and their stale records come off the `authored_by` edge, never `provenance.actor`: on a
 * verified record that field is whoever promoted it, which is the defect v7.1.2 found in the stale queue.
 * A screen built on it would show the reviewer the whole organisation's backlog and every author nothing.
 */
export default function Owner() {
  const t = useT();
  const id = useSearchParams().get("id") ?? "";
  const load = useAsync(
    () => (id ? api.owner(id) : Promise.resolve(null)),
    [id],
  );

  const list = (rows: Knowledge[], empty: string) =>
    rows.length === 0 ? (
      <p className="muted my-0">{empty}</p>
    ) : (
      <ul className="grid gap-2">
        {rows.map((k) => (
          <li key={k.id}>
            <Card className="gap-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={k.effectiveStatus} />
                <Link href={`/entity/?id=${encodeURIComponent(k.id)}`}>
                  {recordLabel(k)}
                </Link>
                <Citation row={k} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    );

  const ids = (rows: string[], empty: string) =>
    rows.length === 0 ? (
      <span className="muted">{empty}</span>
    ) : (
      <span className="flex flex-wrap gap-2">
        {rows.map((x) => (
          <Link key={x} href={`/entity/?id=${encodeURIComponent(x)}`}>
            {x}
          </Link>
        ))}
      </span>
    );

  if (!id) return <p className="muted">{t.owner.needsId}</p>;
  return (
    <>
      {load.error ? <ErrorBanner error={load.error} /> : null}
      {load.loading ? <p className="muted">{t.common.loading}</p> : null}
      {load.data ? (
        <>
          <Panel>
            <PanelHead>
              <CardTitle>{recordLabel(load.data.who)}</CardTitle>
              <span className="mono muted font-normal">
                {load.data.who.type}
              </span>
            </PanelHead>
            <div className="grid gap-2 p-3 text-sm">
              <div>
                {t.owner.owns}: {ids(load.data.owns, t.owner.ownsNothing)}
              </div>
              <div>
                {t.owner.groups}: {ids(load.data.groups, t.owner.noGroups)}
              </div>
              {/* A group's page shows its roster; a person's shows nothing here. */}
              {load.data.members.length > 0 ? (
                <div>
                  {t.owner.members}: {ids(load.data.members, "")}
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHead>
              <CardTitle>{t.owner.awaitingVerify}</CardTitle>
              <span className="muted font-normal">
                {load.data.drafts.length}
              </span>
            </PanelHead>
            <div className="p-3">
              {list(load.data.drafts, t.owner.noDrafts)}
            </div>
          </Panel>

          <Panel>
            <PanelHead>
              <CardTitle>{t.owner.expiring}</CardTitle>
              <span className="muted font-normal">
                {load.data.stale.length}
              </span>
            </PanelHead>
            <div className="p-3">{list(load.data.stale, t.owner.noStale)}</div>
          </Panel>
        </>
      ) : null}
    </>
  );
}
