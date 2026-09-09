"use client";

/**
 * A fixed-column flow diagram: stacked node bars per column, ribbons between them whose width is the
 * count they carry.
 *
 * Shared by the two screens that answer a "where does it go" question — the corpus by status, and one
 * collaboration by author — because the layout is the same problem both times and a second copy would
 * be free to disagree about ribbon order, which is the only thing that decides whether the picture
 * reads or knots.
 *
 * Not a Sankey library: the column count is small and fixed, so the layout is the ~30 lines below.
 * Colour is the caller's, through `tone` on each node: this file knows nothing about statuses.
 */

const W = 900;
/** Room above the columns for their headers, and below the headers before the first bar. */
const TOP = 30;
/**
 * Side inset, in SVG coordinates rather than CSS padding on the wrapper.
 *
 * The wrapper is the horizontal scroll container, and padding on a scroll container is not honoured
 * on the trailing edge once it scrolls — the right-hand column would sit flush against the panel
 * border at exactly the narrow widths the scrolling exists for. Insetting the coordinate space
 * instead holds on both edges at every width.
 */
const PADX = 14;
const PAD = 8;
const BAR = 22;

export interface SankeyNode {
  key: string;
  label: string;
  n: number;
  col: number;
  /** Appended to `flow-` for the CSS class, so a band and its badge can share a palette. */
  tone?: string;
}
export interface SankeyBand {
  from: string;
  to: string;
  n: number;
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

export function Sankey({
  nodes,
  bands,
  total,
  columns,
  height = 440,
  title,
}: {
  nodes: SankeyNode[];
  bands: SankeyBand[];
  /** The denominator every width is a fraction of — the caller's total, not the sum of the bands,
   * so two columns that legitimately do not sum to the same number still scale together. */
  total: number;
  /** One header per column, left to right. Its length is the column count. */
  columns: string[];
  height?: number;
  title: string;
}) {
  const last = columns.length - 1;
  const span = W - BAR - PADX * 2;
  const colX = (c: number) =>
    last === 0 ? PADX : PADX + Math.round((c / last) * span);
  const scale = (n: number) =>
    (n / Math.max(total, 1)) * (height - TOP - PAD * 6);

  // Stack each column in the order the caller gave, then place every ribbon against both of its
  // ends. Each end keeps its own cursor, so a band leaves its source at the height it enters its
  // target — the property that keeps crossings readable.
  const placed = nodes.map((n) => ({ ...n, y: 0, h: 0 }));
  for (let c = 0; c <= last; c++) {
    let y = PAD + TOP;
    for (const n of placed.filter((x) => x.col === c)) {
      n.h = Math.max(scale(n.n), n.n > 0 ? 2 : 0);
      n.y = y;
      y += n.h + PAD;
    }
  }
  const at = new Map(placed.map((n) => [n.key, n]));
  const outCursor = new Map<string, number>();
  const inCursor = new Map<string, number>();
  const drawn = bands.flatMap((b) => {
    const s = at.get(b.from);
    const t = at.get(b.to);
    if (!s || !t || b.n === 0) return [];
    const h = scale(b.n);
    const y0 = outCursor.get(s.key) ?? s.y;
    const y1 = inCursor.get(t.key) ?? t.y;
    outCursor.set(s.key, y0 + h);
    inCursor.set(t.key, y1 + h);
    return [
      {
        key: `${b.from}->${b.to}`,
        tone: t.tone,
        d: ribbon(colX(s.col) + BAR, y0, colX(t.col), y1, h),
      },
    ];
  });

  return (
    // Scrolls inside its own box: the ribbons need the width to stay untangled, and the page body
    // must never scroll sideways.
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="min-w-[720px]"
        role="img"
        aria-label={title}
      >
        <title>{title}</title>
        {columns.map((label, i) => (
          <text
            key={label}
            x={i === last ? colX(i) + BAR : colX(i)}
            y={16}
            textAnchor={i === last ? "end" : "start"}
            className="flow-col"
          >
            {label}
          </text>
        ))}
        {drawn.map((b) => (
          <path
            key={b.key}
            d={b.d}
            className={`flow-band${b.tone ? ` flow-${b.tone}` : ""}`}
          />
        ))}
        {placed.map((n) => (
          <g key={n.key}>
            <rect
              x={colX(n.col)}
              y={n.y}
              width={BAR}
              height={n.h}
              className={`flow-node${n.tone ? ` flow-${n.tone}` : ""}`}
            />
            <text
              x={n.col === last ? colX(n.col) - 6 : colX(n.col) + BAR + 6}
              y={n.y + n.h / 2}
              dominantBaseline="middle"
              textAnchor={n.col === last ? "end" : "start"}
              className="flow-label"
            >
              {n.label} {n.n}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
