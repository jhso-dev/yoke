// Graph model and presentation: everything about the graph that is not drawing pixels.
//
// Split out from the canvas component so it is testable in the existing vitest with no browser — the
// layout is d3-force's job, but merging expansions, capping size, colouring by type and describing
// truncation are ours, and those are where the bugs would be.

import type { Edge, GraphData, Knowledge, Status } from "./types";

/**
 * ponytail: hard client-side ceiling on drawn nodes. d3-force uses a quadtree so it scales further,
 * but past a few hundred nodes a force layout is unreadable regardless of frame rate — the honest
 * answer is to narrow the query, not to draw more. Also stops a future server-side limit bump from
 * melting a browser. Raise it only with a screenshot of it still being legible.
 */
export const MAX_NODES = 300;

export interface GraphNode {
  id: string;
  type: string;
  status: Status;
  label: string;
  citation: string;
  /** Simulation state, mutated by d3-force. */
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  degree: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  id: string;
  type: string;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** More exists than is drawn — always surfaced, never swallowed. */
  truncated: boolean;
  /** How many nodes the server offered before the client cap. */
  offered: number;
}

/** Build a drawable graph from an API response, capping nodes and dropping now-dangling edges. */
export function toGraph(data: GraphData): Graph {
  const capped = data.nodes.slice(0, MAX_NODES);
  const present = new Set(capped.map((n) => n.id));
  // An edge whose endpoint was cut cannot be drawn. The server documents that a truncated response
  // may reference nodes outside `nodes`, so dropping is expected rather than a data error.
  const links = data.edges
    .filter((e) => present.has(e.from) && present.has(e.to))
    .map(edgeToLink);
  const degree = new Map<string, number>();
  for (const l of links) {
    for (const end of [l.source, l.target] as string[])
      degree.set(end, (degree.get(end) ?? 0) + 1);
  }
  return {
    nodes: capped.map((n) => nodeOf(n, degree.get(n.id) ?? 0)),
    links,
    truncated: data.truncated || data.nodes.length > capped.length,
    offered: data.nodes.length,
  };
}

/**
 * Fold an expansion into the current graph, keeping existing nodes' positions.
 *
 * Preserving position is what makes expanding feel like exploring rather than re-rolling: replacing
 * the node objects would restart the simulation from scratch and throw away the layout the user has
 * been reading.
 */
export function mergeGraph(current: Graph, incoming: GraphData): Graph {
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  const added = toGraph(incoming);
  for (const n of added.nodes) {
    const existing = byId.get(n.id);
    if (existing) continue;
    byId.set(n.id, n);
  }
  const nodes = [...byId.values()].slice(0, MAX_NODES);
  const present = new Set(nodes.map((n) => n.id));
  const linkIds = new Set<string>();
  const links: GraphLink[] = [];
  for (const l of [...current.links, ...added.links]) {
    if (linkIds.has(l.id)) continue;
    const s = endId(l.source);
    const t = endId(l.target);
    if (!present.has(s) || !present.has(t)) continue;
    linkIds.add(l.id);
    links.push({ id: l.id, type: l.type, source: s, target: t });
  }
  const degree = new Map<string, number>();
  for (const l of links) {
    for (const end of [endId(l.source), endId(l.target)])
      degree.set(end, (degree.get(end) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
  return {
    nodes,
    links,
    truncated: current.truncated || added.truncated || byId.size > nodes.length,
    offered: current.offered + added.offered,
  };
}

function nodeOf(k: Knowledge, degree: number): GraphNode {
  return {
    id: k.id,
    type: k.type,
    status: k.effectiveStatus,
    label: k.summary || k.id,
    citation: k.citation,
    degree,
    ...seed(k.id),
  };
}

function edgeToLink(e: Edge): GraphLink {
  return { id: e.id, type: e.type, source: e.from, target: e.to };
}

export function endId(end: string | GraphNode): string {
  return typeof end === "string" ? end : end.id;
}

/**
 * Deterministic starting position, hashed from the id.
 *
 * Not Math.random: a reload would otherwise produce a different layout for the same data, which makes
 * the graph feel unstable and makes layout tests non-repeatable.
 */
function seed(id: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 3600) / 3600;
  const r = 60 + (((h >>> 12) >>> 0) % 240);
  return { x: Math.cos(a * Math.PI * 2) * r, y: Math.sin(a * Math.PI * 2) * r };
}

/**
 * A colour per ontology type, distinct by construction.
 *
 * Hashing the type name into a fixed palette was the first attempt and it collided immediately on
 * the seeded ontology (`decision` and `fact` landed on the same hue), which makes a legend lie. So
 * hues are spread evenly across the types actually present, sorted for stability — no palette to
 * outgrow, no config, and no two visible types can share a colour.
 */
export function makeTypeColors(types: string[]): (type: string) => string {
  const sorted = [...new Set(types)].sort();
  const step = 360 / Math.max(sorted.length, 1);
  const map = new Map(
    sorted.map((t, i) => [t, `hsl(${Math.round(i * step)} 62% 48%)`]),
  );
  return (t) => map.get(t) ?? "hsl(0 0% 55%)";
}

/** Node radius from degree — hubs read as hubs. Clamped so nothing dominates or disappears. */
export function nodeRadius(degree: number): number {
  return Math.min(12, 4 + Math.sqrt(degree) * 2.2);
}

/** The truncation sentence, or null when nothing was cut. Never a silent slice. */
export function truncationNotice(g: Graph): string | null {
  if (!g.truncated) return null;
  return `showing ${g.nodes.length} of ${Math.max(g.offered, g.nodes.length + 1)}+ nodes — narrow by type or status, or open a single record and expand from there`;
}
