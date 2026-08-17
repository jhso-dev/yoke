"use client";

import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Panel, PanelHead } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useAsync } from "../../lib/useAsync";

/**
 * The scorecard: four checks per catalog record, worst first.
 *
 * Not a rules engine — the facts the checks want are already in the schema, so each check is a query and
 * the score is how many passed. Unweighted on purpose: a weighting scheme would be a number chosen to be
 * met, the same reason the retrieval eval has no pass mark.
 *
 * The check no descriptor-driven portal can run is the first one: a service whose OWNER record is stale,
 * retired or absent is not green. Absence scores as well as rot, so a service with nothing recorded about
 * it cannot pass by being quiet.
 */
export default function Scorecard() {
  const t = useT();
  const rows = useAsync(() => api.scorecard(), []);

  return (
    <Panel>
      <PanelHead>
        <CardTitle>{t.scorecard.title}</CardTitle>
        <span className="muted font-normal">{t.scorecard.hint}</span>
      </PanelHead>
      {rows.error ? <ErrorBanner error={rows.error} /> : null}
      {rows.loading ? <p className="muted">{t.common.loading}</p> : null}
      {rows.data ? (
        rows.data.length === 0 ? (
          <p className="muted">{t.scorecard.empty}</p>
        ) : (
          <>
            <p className="muted">
              {t.scorecard.summary(
                rows.data.filter((r) => r.score === r.of).length,
                rows.data.length,
              )}
            </p>
            <ul className="grid gap-2">
              {rows.data.map((r) => (
                <li key={r.id}>
                  <Card className="gap-1 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          r.score === r.of ? "mono" : "mono warn font-semibold"
                        }
                      >
                        {r.score}/{r.of}
                      </span>
                      <Link href={`/entity/?id=${encodeURIComponent(r.id)}`}>
                        {r.name}
                      </Link>
                      <span className="mono muted">{r.type}</span>
                    </div>
                    {/* Only the failures, each stating why in the record's own terms — a bare score is a
                        number nobody can act on. */}
                    {r.checks
                      .filter((c) => !c.pass)
                      .map((c) => (
                        <p className="my-0 text-sm" key={c.id}>
                          <span className="mono muted">{c.id}</span>{" "}
                          <span className="warn">{c.detail}</span>
                        </p>
                      ))}
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
