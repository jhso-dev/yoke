"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardTitle } from "@/components/ui/card";
import { Citation } from "../../components/Citation";
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { CatalogRow } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * The portal's front door: what the organisation runs.
 *
 * WEB-UI.md's test 1 was amended (v7.3) to admit this screen on one condition, and the condition is the
 * whole design: **every row shows its effective status, its stale count and its owner.** A catalog that
 * cannot be read without seeing what has rotted is a governance surface; one that hides it is the decay
 * that makes descriptor-driven portals lie. So the health columns come first, rows arrive most-rotted
 * first from the server, and there is no way to view this list without them.
 *
 * Still forbidden here, and absent: prose about a service, any authoring surface, any health this
 * database did not check.
 */
export default function Catalog() {
  const t = useT();
  const [staleOnly, setStaleOnly] = useState(false);
  const rows = useAsync(
    () => api.catalog(staleOnly ? { stale: 1 } : {}),
    [staleOnly],
  );

  const summary = (list: CatalogRow[]) =>
    t.catalog.summary(
      list.length,
      list.filter((r) => r.stale > 0).length,
      list.filter((r) => r.owners.length === 0).length,
    );

  return (
    <Panel>
      <PanelHead>
        <CardTitle>{t.catalog.title}</CardTitle>
        <span className="muted font-normal">{t.catalog.hint}</span>
      </PanelHead>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={staleOnly}
          onChange={(e) => setStaleOnly(e.target.checked)}
        />
        {t.catalog.staleOnly}
      </label>
      {/*
        "Create a new service" (v7.5), and it generates nothing.
        A template engine would rot silently — nobody notices until the tenth service is wrong. The
        conventions live as verified records instead, so they expire and come back to their owner through
        the queue that already exists; this hands the agent the injection that carries them. The screen
        dispatches, the agent scaffolds.
      */}
      <div className="controls">
        <span className="muted">{t.catalog.newService}</span>
        <CopyCode value='yoke inject "starting a new service"' />
      </div>
      {rows.error ? <ErrorBanner error={rows.error} /> : null}
      {rows.loading ? <p className="muted">{t.common.loading}</p> : null}
      {rows.data ? (
        rows.data.length === 0 ? (
          <p className="muted">{t.catalog.empty}</p>
        ) : (
          <>
            <p className="muted">{summary(rows.data)}</p>
            <ul className="grid gap-2">
              {rows.data.map((r) => (
                <li key={r.id}>
                  <Card className="gap-1 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} />
                      <Link href={`/entity/?id=${encodeURIComponent(r.id)}`}>
                        {r.name}
                      </Link>
                      <span className="mono muted">{r.type}</span>
                      {/* A catalog row is a record, so it carries its source like every other surface
                          that shows one — and the citation is what tells a hand-typed service from an
                          imported one. */}
                      <Citation row={r} />
                      {r.lifecycle ? (
                        <span className="muted">{r.lifecycle}</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-3 text-sm">
                      <span>
                        {t.catalog.owner}:{" "}
                        {r.owners.length === 0 ? (
                          // Not a blank: an unowned service is the finding this column exists for.
                          <span className="muted">{t.catalog.unowned}</span>
                        ) : (
                          // Every owner, linked to their load rather than their record — the question a
                          // reader of this column has is "what else is this group on the hook for". Two
                          // owners is itself a finding, so both are shown and the contest is named.
                          <>
                            {r.owners.map((o, i) => (
                              <span key={o}>
                                {i > 0 ? ", " : ""}
                                <Link
                                  href={`/owner/?id=${encodeURIComponent(o)}`}
                                >
                                  {o}
                                </Link>
                              </span>
                            ))}
                            {r.owners.length > 1 ? (
                              <span className="warn">
                                {" "}
                                {t.catalog.contested}
                              </span>
                            ) : null}
                          </>
                        )}
                      </span>
                      <span>{t.catalog.deps(r.dependsOn, r.dependents)}</span>
                      <span>{t.catalog.docs(r.docs)}</span>
                      {/* Stale is stated even at zero, so "0 stale" is a checked claim rather than the
                          absence of a check. */}
                      <span className={r.stale > 0 ? "warn" : undefined}>
                        {t.catalog.stale(r.stale)}
                      </span>
                      {r.conflicts > 0 ? (
                        <span className="warn">
                          {t.catalog.conflicts(r.conflicts)}
                        </span>
                      ) : null}
                    </div>
                    {r.latestDecision ? (
                      <p className="my-0 min-w-0 break-words text-sm">
                        {t.catalog.lastDecision}:{" "}
                        <Link
                          href={`/entity/?id=${encodeURIComponent(r.latestDecision.id)}`}
                        >
                          {r.latestDecision.summary}
                        </Link>
                      </p>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </Panel>
  );
}
