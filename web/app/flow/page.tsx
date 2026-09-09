"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Alert } from "@/components/ui/alert";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Panel } from "../../components/Panel";
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
 * ceiling: three columns. A fourth for the SOURCE a record came from is the obvious next one and is
 * deliberately absent: `provenance.origin` on a promoted record is `lifecycle` (the transition wrote
 * that version), so a source column means a history walk per record — affordable in a view, but not
 * worth it until a corpus actually mixes connectors. A fifth for CONSUMPTION (`consumptionCounts`
 * over the audit trail) needs injection traffic to say anything.
 */

/** Sized to the widest label pair; the SVG scales to its box, so this is a coordinate space. */
const W = 900;
const H = 440;
/** Room above the columns for their headers, so a bar never starts under its own label. */
const TOP = 18;
const PAD = 8;
const BAR = 22;
/** Column x positions for the three node bars. */
const COLX = [0, W / 2 - BAR / 2, W - BAR];

const STATUSES: Status[] = ["verified", "stale", "draft", "deprecated"];

/** Where each status lands. `verified` is the only one an agent is told — the rest carry a reason. */
type Outcome = "injected" | "withheld" | "structural";

interface Band {
  from: string;
  to: string;
  n: number;
}
interface Node {
  key: string;
  label: string;
  n: number;
  col: number;
  y: number;
  h: number;
}

/** A cubic S-curve between two stacked bands — the ribbon shape, drawn as a filled area. */
function ribbon(x0: number, y0: number, x1: number, y1: number, h: number) {
  const mx = (x0 + x1) / 2;
  return [
    `M${x0},${y0}`,
    `C${mx},${y0} ${mx},${y1} ${x1},${y1}`,
    `l0,${h}`,
    `C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h}`,
    "Z",
  ].join(" ");
}

/**
 * Stack every column and place each ribbon against both of its ends.
 *
 * Ribbons are laid out in the same order the nodes are, and each end keeps its own cursor, so a band
 * leaves its source at the same height it enters its target — the property that makes the picture
 * readable rather than a knot.
 */
function layout(nodes: Node[], bands: Band[], total: number) {
  const scale = (n: number) => (n / Math.max(total, 1)) * (H - TOP - PAD * 6);
  const byCol = [0, 1, 2].map((c) => nodes.filter((n) => n.col === c));
  for (const col of byCol) {
    let y = PAD + TOP;
    for (const n of col) {
      n.h = Math.max(scale(n.n), n.n > 0 ? 2 : 0);
      n.y = y;
      y += n.h + PAD;
    }
  }
  const at = new Map(nodes.map((n) => [n.key, n]));
  const outCursor = new Map<string, number>();
  const inCursor = new Map<string, number>();
  return bands.flatMap((b) => {
    const s = at.get(b.from);
    const t = at.get(b.to);
    if (!s || !t || b.n === 0) return [];
    const h = scale(b.n);
    const y0 = (outCursor.get(s.key) ?? s.y) as number;
    const y1 = (inCursor.get(t.key) ?? t.y) as number;
    outCursor.set(s.key, y0 + h);
    inCursor.set(t.key, y1 + h);
    return [{ ...b, d: ribbon(COLX[s.col] + BAR, y0, COLX[t.col], y1, h) }];
  });
}

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
    const types = Object.entries(ov.entities.byType).filter(([, c]) =>
      STATUSES.some((s) => c[s] > 0),
    );
    const total = ov.entities.total;

    const nodes: Node[] = [];
    const bands: Band[] = [];
    const bump = (key: string, n: number, col: number, label: string) => {
      const hit = nodes.find((x) => x.key === key);
      if (hit) hit.n += n;
      else nodes.push({ key, label, n, col, y: 0, h: 0 });
    };
    const outcomeOf = (type: string, s: Status): Outcome =>
      structural.has(type)
        ? "structural"
        : s === "verified"
          ? "injected"
          : "withheld";

    for (const [type, counts] of types) {
      const n = STATUSES.reduce((a, s) => a + counts[s], 0);
      bump(`t:${type}`, n, 0, type);
      for (const s of STATUSES) {
        if (counts[s] === 0) continue;
        bump(`s:${s}`, counts[s], 1, s);
        bands.push({ from: `t:${type}`, to: `s:${s}`, n: counts[s] });
        const o = outcomeOf(type, s);
        bump(`o:${o}`, counts[s], 2, t.flow[o]);
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
    const drawn = layout(nodes, bands, total);
    const injectable = nodes.find((n) => n.key === "o:injected")?.n ?? 0;
    return { nodes, drawn, total, injectable };
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
        {/* Scrolls inside its own box: the ribbons need the full width to stay untangled, and the
            page body must never scroll sideways. */}
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="min-w-[720px]"
            role="img"
            aria-label={t.flow.heading}
          >
            <title>{t.flow.heading}</title>
            {/* Column headers, like the reference this screen borrows its shape from: an unlabelled
                Sankey makes the reader infer what each stack means. */}
            {[t.flow.colType, t.flow.colStatus, t.flow.colOutcome].map(
              (label, i) => (
                <text
                  key={label}
                  x={i === 2 ? COLX[i] + BAR : COLX[i]}
                  y={10}
                  textAnchor={i === 2 ? "end" : "start"}
                  className="flow-col"
                >
                  {label}
                </text>
              ),
            )}
            {model.drawn.map((b) => (
              <path
                key={`${b.from}->${b.to}`}
                d={b.d}
                className={`flow-band flow-${b.to.replace(":", "-")}`}
              />
            ))}
            {model.nodes.map((n) => (
              <g key={n.key}>
                <rect
                  x={COLX[n.col]}
                  y={n.y}
                  width={BAR}
                  height={n.h}
                  className={`flow-node flow-${n.key.replace(":", "-")}`}
                />
                <text
                  x={n.col === 2 ? COLX[n.col] - 6 : COLX[n.col] + BAR + 6}
                  y={n.y + n.h / 2}
                  dominantBaseline="middle"
                  textAnchor={n.col === 2 ? "end" : "start"}
                  className="flow-label"
                >
                  {n.label} {n.n}
                </text>
              </g>
            ))}
          </svg>
        </div>
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
            {/* The queue that empties this band: the screen ends on an action, not only a number.
                Its own sentence, because a bare nav word inside the explanation reads as part of it. */}
            <Link href="/review/">→ {t.nav.review}</Link>
          </dd>
          <dt>{t.flow.structural}</dt>
          <dd>{t.flow.structuralNote}</dd>
        </dl>
      </Panel>
    </>
  );
}
