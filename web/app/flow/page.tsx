"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Panel } from "../../components/Panel";
import {
  Sankey,
  type SankeyBand,
  type SankeyNode,
} from "../../components/Sankey";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { Overview, Status, TypeDef } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * Where knowledge goes: type → effective status → whether an agent can be told it today.
 *
 * The other screens answer "what is in here" one record at a time. This one answers it in
 * PROPORTION, and the proportion is the governance model made visible: the gap between what is
 * stored and what is injectable is the whole of "lenient on write, strict on injection", and no
 * other surface shows it as a quantity.
 *
 * It renders `overview` and recounts nothing — `stale` is computed there, at read time, so the
 * middle column is already the difference between "stored verified" and "injectable today".
 *
 * The per-collaboration counterpart lives on the collaboration screen: this one is the whole
 * namespace by status, that one is one unit of work by author.
 */

const STATUSES: Status[] = ["verified", "stale", "draft", "deprecated"];

/** Where each status lands. `verified` is the only one an agent is told — the rest carry a reason. */
type Outcome = "injected" | "withheld" | "structural";

export default function Flow() {
  const t = useT();
  const data = useAsync(
    () => Promise.all([api.overview(), api.ontology()]),
    [],
  );

  const model = useMemo(() => {
    if (!data.data) return null;
    const [ov, ontology]: [Overview, TypeDef[]] = data.data;
    // Structural types never reach an agent as knowledge whatever their status, so they get their own
    // outcome rather than being counted as injected — the same rule core applies (`inject` withholds
    // by type), said in the picture instead of only in the total.
    const structural = new Set(
      ontology.filter((d) => d.structural).map((d) => d.name),
    );
    const total = ov.entities.total;
    const nodes: SankeyNode[] = [];
    const bands: SankeyBand[] = [];
    const bump = (
      key: string,
      n: number,
      col: number,
      label: string,
      tone?: string,
    ) => {
      const hit = nodes.find((x) => x.key === key);
      if (hit) hit.n += n;
      else nodes.push({ key, label, n, col, tone });
    };
    const outcomeOf = (type: string, s: Status): Outcome =>
      structural.has(type)
        ? "structural"
        : s === "verified"
          ? "injected"
          : "withheld";

    for (const [type, counts] of Object.entries(ov.entities.byType)) {
      const n = STATUSES.reduce((a, s) => a + counts[s], 0);
      if (n === 0) continue;
      bump(`t:${type}`, n, 0, type);
      for (const s of STATUSES) {
        if (counts[s] === 0) continue;
        bump(`s:${s}`, counts[s], 1, s, `s-${s}`);
        bands.push({ from: `t:${type}`, to: `s:${s}`, n: counts[s] });
        const o = outcomeOf(type, s);
        bump(`o:${o}`, counts[s], 2, t.flow[o], `o-${o}`);
        bands.push({ from: `s:${s}`, to: `o:${o}`, n: counts[s] });
      }
    }
    // Column order is fixed rather than by size, so the eye reads the same shape on every corpus and
    // the outcome column always ends on the withheld side.
    const rank = (k: string) =>
      k.startsWith("s:")
        ? STATUSES.indexOf(k.slice(2) as Status)
        : k.startsWith("o:")
          ? ["injected", "structural", "withheld"].indexOf(k.slice(2))
          : 0;
    nodes.sort(
      (a, b) => a.col - b.col || rank(a.key) - rank(b.key) || b.n - a.n,
    );
    const injectable = nodes.find((n) => n.key === "o:injected")?.n ?? 0;
    return { nodes, bands, total, injectable };
  }, [data.data, t]);

  if (!model) return null;
  if (model.total === 0) return <Alert variant="info">{t.flow.empty}</Alert>;

  const reason: Record<string, string> = {
    draft: t.flow.reasonDraft,
    stale: t.flow.reasonStale,
    deprecated: t.flow.reasonDeprecated,
  };

  return (
    <>
      <h1>{t.flow.heading}</h1>
      <p className="lede">{t.flow.lede}</p>
      <ErrorBanner error={data.error} onRetry={data.reload} />
      <Panel>
        <Sankey
          nodes={model.nodes}
          bands={model.bands}
          total={model.total}
          columns={[t.flow.colType, t.flow.colStatus, t.flow.colOutcome]}
          title={t.flow.heading}
        />
      </Panel>
      <Alert variant="info">
        {t.flow.summary
          .replace("{injectable}", String(model.injectable))
          .replace("{total}", String(model.total))}
      </Alert>
      <Panel>
        <dl className="flow-legend">
          <dt>{t.flow.injected}</dt>
          <dd>{t.flow.injectedNote}</dd>
          <dt>{t.flow.withheld}</dt>
          <dd>
            {t.flow.withheldNote} —{" "}
            {STATUSES.filter((s) => s !== "verified")
              .map((s) => `${s}: ${reason[s]}`)
              .join(", ")}
            .{" "}
            {/* The queue that empties this band: the screen ends on an action, not only a number. */}
            <Link href="/review/">→ {t.nav.review}</Link>
          </dd>
          <dt>{t.flow.structural}</dt>
          <dd>{t.flow.structuralNote}</dd>
        </dl>
      </Panel>
    </>
  );
}
