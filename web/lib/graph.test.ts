import { describe, expect, it } from "vitest";
import {
  endId,
  MAX_NODES,
  makeTypeColors,
  membershipTypes,
  mergeGraph,
  nodeRadius,
  toGraph,
  truncationCounts,
} from "./graph";
import type { Edge, GraphData, Knowledge } from "./types";

const node = (id: string, type = "fact"): Knowledge => ({
  id,
  type,
  version: 1,
  status: "verified",
  effectiveStatus: "verified",
  summary: `about ${id}`,
  actor: "tester",
  occurred_at: "2026-01-01T00:00:00Z",
  citation: `[${type}:${id}@v1] tester, 2026-01-01T00:00:00Z`,
});

const edge = (
  id: string,
  from: string,
  to: string,
  type = "relates_to",
): Edge => ({
  ...node(id, type),
  from,
  to,
});

const data = (over: Partial<GraphData> = {}): GraphData => ({
  anchor: null,
  nodes: [],
  edges: [],
  next: { nodes: null, edges: null },
  truncated: false,
  limit: 300,
  ...over,
});

describe("toGraph", () => {
  it("keeps edges whose ends are both present and computes degree", () => {
    const g = toGraph(
      data({
        nodes: [node("a"), node("b"), node("c")],
        edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
      }),
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(g.links.map((l) => l.id)).toEqual(["e1", "e2"]);
    // b sits on both edges, so it is the hub.
    expect(g.nodes.find((n) => n.id === "b")?.degree).toBe(2);
    expect(g.nodes.find((n) => n.id === "a")?.degree).toBe(1);
    expect(g.truncated).toBe(false);
  });

  it("drops edges left dangling by truncation rather than drawing them into nothing", () => {
    // The server documents that a truncated response may reference nodes outside `nodes`.
    const g = toGraph(
      data({
        nodes: [node("a")],
        edges: [edge("e1", "a", "cut-away")],
        truncated: true,
      }),
    );
    expect(g.links).toEqual([]);
    expect(g.truncated).toBe(true);
  });

  it("enforces the client cap and reports it, even when the server said nothing was truncated", () => {
    const many = Array.from({ length: MAX_NODES + 25 }, (_, i) =>
      node(`n${String(i).padStart(4, "0")}`),
    );
    const g = toGraph(data({ nodes: many }));
    expect(g.nodes).toHaveLength(MAX_NODES);
    expect(g.truncated).toBe(true);
    // The numbers, not a sentence — the wording is t.graph.truncated's now.
    expect(truncationCounts(g)).toEqual({
      shown: MAX_NODES,
      offered: MAX_NODES + 25,
    });
  });

  it("seeds positions deterministically, so a reload is the same layout", () => {
    const first = toGraph(data({ nodes: [node("a"), node("b")] }));
    const second = toGraph(data({ nodes: [node("a"), node("b")] }));
    expect(first.nodes.map((n) => [n.x, n.y])).toEqual(
      second.nodes.map((n) => [n.x, n.y]),
    );
    // Distinct ids must not stack on the same point.
    expect(first.nodes[0].x).not.toBe(first.nodes[1].x);
  });
});

describe("mergeGraph", () => {
  it("keeps existing positions, so expanding explores instead of re-rolling the layout", () => {
    const base = toGraph(
      data({ nodes: [node("a"), node("b")], edges: [edge("e1", "a", "b")] }),
    );
    // Simulate the layout having settled somewhere.
    const a = base.nodes.find((n) => n.id === "a");
    if (a) {
      a.x = 123;
      a.y = -45;
    }
    const merged = mergeGraph(
      base,
      data({ nodes: [node("b"), node("c")], edges: [edge("e2", "b", "c")] }),
    );
    expect(merged.nodes.find((n) => n.id === "a")?.x).toBe(123);
    expect(merged.nodes.find((n) => n.id === "a")?.y).toBe(-45);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate a node or an edge already drawn", () => {
    const base = toGraph(
      data({ nodes: [node("a"), node("b")], edges: [edge("e1", "a", "b")] }),
    );
    const merged = mergeGraph(
      base,
      data({ nodes: [node("a"), node("b")], edges: [edge("e1", "a", "b")] }),
    );
    expect(merged.nodes).toHaveLength(2);
    expect(merged.links).toHaveLength(1);
  });

  it("recomputes degree across the merged whole", () => {
    const base = toGraph(
      data({ nodes: [node("a"), node("b")], edges: [edge("e1", "a", "b")] }),
    );
    const merged = mergeGraph(
      base,
      data({ nodes: [node("b"), node("c")], edges: [edge("e2", "b", "c")] }),
    );
    expect(merged.nodes.find((n) => n.id === "b")?.degree).toBe(2);
  });

  it("counts each offered record once, however many expansions offer it again", () => {
    // What this pins: `offered` is a set, not `current.offered + added.offered` — summing counts a
    // node already drawn once per expansion, and repeatedly expanding an overlapping neighbourhood
    // announces "showing 300 of 1500+" over a corpus of 340.
    const many = Array.from({ length: MAX_NODES + 40 }, (_, i) =>
      node(`n${String(i).padStart(4, "0")}`),
    );
    let g = toGraph(data({ nodes: many }));
    for (let i = 0; i < 5; i++) g = mergeGraph(g, data({ nodes: many }));
    expect(truncationCounts(g)).toEqual({
      shown: MAX_NODES,
      offered: many.length,
    });
  });

  it("unions in the ids an expansion offered for the first time", () => {
    const base = toGraph(data({ nodes: [node("a")] }));
    const merged = mergeGraph(base, data({ nodes: [node("a"), node("b")] }));
    expect([...merged.offered].sort()).toEqual(["a", "b"]);
  });

  it("respects the cap when a merge would exceed it", () => {
    const base = toGraph(
      data({
        nodes: Array.from({ length: MAX_NODES - 1 }, (_, i) => node(`b${i}`)),
      }),
    );
    const merged = mergeGraph(
      base,
      data({ nodes: Array.from({ length: 40 }, (_, i) => node(`x${i}`)) }),
    );
    expect(merged.nodes).toHaveLength(MAX_NODES);
    expect(merged.truncated).toBe(true);
  });
});

describe("presentation", () => {
  it("gives every present type a distinct colour — a legend that collides is a legend that lies", () => {
    // The seeded ontology, which is where the first hash-into-a-palette attempt collided.
    const types = [
      "person",
      "fact",
      "decision",
      "term",
      "resource",
      "collaboration",
      "authored_by",
      "relates_to",
      "conflicts_with",
      "works_on",
    ];
    const color = makeTypeColors(types);
    const used = types.map(color);
    expect(new Set(used).size).toBe(types.length);
    // Stable for the same type set, and order-independent.
    expect(makeTypeColors([...types].reverse())("decision")).toBe(
      color("decision"),
    );
    // A type that was not in the set still renders, in grey rather than crashing.
    expect(color("unknown-type")).toContain("0%");
  });

  it("scales radius with degree, clamped at both ends", () => {
    expect(nodeRadius(0)).toBeGreaterThanOrEqual(4);
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(9));
    expect(nodeRadius(10_000)).toBeLessThanOrEqual(12);
  });

  it("says nothing when nothing was cut", () => {
    expect(truncationCounts(toGraph(data({ nodes: [node("a")] })))).toBeNull();
  });

  it("reads an endpoint whether d3 has replaced it with an object yet or not", () => {
    expect(endId("a")).toBe("a");
    expect(endId({ id: "b" } as never)).toBe("b");
  });

  it("takes membership edges from the ontology, not from the name `works_on`", () => {
    // An org that calls its roster edge something else must still get the not-knowledge dash — the
    // flag is stored as data for exactly that reason, so a hardcoded name here would be a silent
    // regression for every one of them.
    const m = membershipTypes([
      { name: "assigned_to", kind: "relation", attrs: {}, membership: true },
      { name: "relates_to", kind: "relation", attrs: {} },
      // A flag on an entity type is not a relation and must not leak into the edge set.
      { name: "collaboration", kind: "entity", attrs: {}, membership: true },
    ]);
    expect([...m]).toEqual(["assigned_to"]);
    // No ontology yet (it loads on its own request) → nothing dashed, never a crash.
    expect(membershipTypes([]).size).toBe(0);
  });
});
