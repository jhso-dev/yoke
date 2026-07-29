"use client";

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import { useEffect, useRef } from "react";
import {
  endId,
  type Graph,
  type GraphLink,
  type GraphNode,
  nodeRadius,
} from "../lib/graph";

/**
 * Canvas 2D, not SVG: a few hundred nodes under drag means a few hundred mutating DOM nodes per
 * frame in SVG, versus one element here with a devicePixelRatio transform.
 *
 * The loop stops when the layout settles and while the tab is hidden — a workbench left open in a
 * background tab must not keep a core busy.
 */
export function GraphCanvas({
  graph,
  colorOf,
  selected,
  onSelect,
  onExpand,
}: {
  graph: Graph;
  colorOf: (type: string) => string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  // View transform lives in a ref, not state: panning and zooming must not re-render React.
  const view = useRef({ k: 1, x: 0, y: 0 });
  const dragging = useRef<GraphNode | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let stop = false;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      return { dpr, w: rect.width, h: rect.height };
    };
    let { dpr, w, h } = resize();

    const sim = forceSimulation<GraphNode, GraphLink>(graph.nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(graph.links)
          .id((d) => d.id)
          .distance(70)
          .strength(0.35),
      )
      .force("charge", forceManyBody().strength(-140).distanceMax(420))
      .force("center", forceCenter(0, 0).strength(0.06))
      .alphaDecay(0.035)
      .stop();
    simRef.current = sim;

    /** Screen → simulation coordinates, so hit testing follows pan and zoom. */
    const toSim = (px: number, py: number) => {
      const { k, x, y } = view.current;
      return { x: (px - w / 2 - x) / k, y: (py - h / 2 - y) / k };
    };

    const hit = (px: number, py: number): GraphNode | null => {
      const p = toSim(px, py);
      let best: GraphNode | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const n of graph.nodes) {
        const dx = (n.x ?? 0) - p.x;
        const dy = (n.y ?? 0) - p.y;
        const d = Math.hypot(dx, dy);
        const r = nodeRadius(n.degree) + 6;
        if (d < r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };

    const draw = () => {
      const { k, x, y } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + x, h / 2 + y);
      ctx.scale(k, k);

      // Edges first so nodes sit on top.
      ctx.lineWidth = 1 / k;
      for (const l of graph.links) {
        const s = l.source as GraphNode;
        const t = l.target as GraphNode;
        if (typeof s === "string" || typeof t === "string") continue;
        ctx.strokeStyle =
          l.type === "conflicts_with"
            ? "rgba(220,60,60,0.75)"
            : "rgba(130,138,150,0.45)";
        ctx.setLineDash(l.type === "authored_by" ? [3 / k, 3 / k] : []);
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of graph.nodes) {
        const r = nodeRadius(n.degree);
        const isSel = n.id === selected;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
        // Status by SHAPE as well as colour: hollow+dashed draft, solid verified, faded stale,
        // grey ✕ deprecated. Colour alone would be unreadable to a meaningful share of people.
        ctx.globalAlpha = n.status === "stale" ? 0.45 : 1;
        if (n.status === "draft") {
          ctx.fillStyle = "transparent";
          ctx.strokeStyle = colorOf(n.type);
          ctx.lineWidth = 1.6 / k;
          ctx.setLineDash([2.5 / k, 2.5 / k]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.status === "deprecated") {
          ctx.fillStyle = "rgba(140,140,150,0.5)";
          ctx.fill();
        } else {
          ctx.fillStyle = colorOf(n.type);
          ctx.fill();
        }
        if (isSel) {
          ctx.strokeStyle = "#0d9488";
          ctx.lineWidth = 2.5 / k;
          ctx.beginPath();
          ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (n.status === "deprecated") {
          ctx.strokeStyle = "rgba(90,90,100,0.9)";
          ctx.lineWidth = 1.4 / k;
          ctx.beginPath();
          ctx.moveTo((n.x ?? 0) - r / 1.6, (n.y ?? 0) - r / 1.6);
          ctx.lineTo((n.x ?? 0) + r / 1.6, (n.y ?? 0) + r / 1.6);
          ctx.moveTo((n.x ?? 0) + r / 1.6, (n.y ?? 0) - r / 1.6);
          ctx.lineTo((n.x ?? 0) - r / 1.6, (n.y ?? 0) + r / 1.6);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // Labels only when zoomed in or selected — otherwise they overlap into noise.
        if (k > 1.15 || isSel) {
          ctx.fillStyle = "rgba(120,126,138,0.95)";
          ctx.font = `${11 / k}px ui-monospace, monospace`;
          ctx.fillText(
            n.label.slice(0, 28),
            (n.x ?? 0) + r + 3 / k,
            (n.y ?? 0) + 3 / k,
          );
        }
      }
    };

    const tick = () => {
      if (stop) return;
      if (!document.hidden) {
        sim.tick();
        draw();
      }
      // Settled and nothing being dragged → stop burning frames.
      if (sim.alpha() < 0.02 && !dragging.current) {
        draw();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    sim.alpha(0.9);
    frame = requestAnimationFrame(tick);

    const wake = () => {
      sim.alpha(Math.max(sim.alpha(), 0.35));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };

    const onPointerDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const n = hit(e.clientX - rect.left, e.clientY - rect.top);
      if (n) {
        dragging.current = n;
        n.fx = n.x;
        n.fy = n.y;
        onSelect(n.id);
        wake();
      } else {
        onSelect(null);
      }
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const n = dragging.current;
      if (!n) return;
      const rect = canvas.getBoundingClientRect();
      const p = toSim(e.clientX - rect.left, e.clientY - rect.top);
      n.fx = p.x;
      n.fy = p.y;
      wake();
    };
    const onPointerUp = () => {
      const n = dragging.current;
      if (n) {
        // Release the pin so the layout can settle around the new position.
        n.fx = null;
        n.fy = null;
      }
      dragging.current = null;
    };
    const onDoubleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const n = hit(e.clientX - rect.left, e.clientY - rect.top);
      if (n) onExpand(n.id);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0016);
      view.current.k = Math.min(4, Math.max(0.25, view.current.k * f));
      draw();
    };
    const onResize = () => {
      ({ dpr, w, h } = resize());
      draw();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", wake);

    return () => {
      stop = true;
      cancelAnimationFrame(frame);
      sim.stop();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [graph, colorOf, selected, onSelect, onExpand]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: 520,
        display: "block",
        cursor: "grab",
        touchAction: "none",
      }}
      // Out of the accessibility tree AND out of the tab order: a canvas can take focus, and
      // aria-hidden on a focusable element strands screen-reader users on an element they cannot
      // perceive. The node list below the canvas is the accessible path to the same data.
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
