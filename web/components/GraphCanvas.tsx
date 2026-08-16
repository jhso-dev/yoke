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
  type Graph,
  type GraphLink,
  type GraphNode,
  nodeRadius,
} from "../lib/graph";

/**
 * Canvas 2D, not SVG: a few hundred nodes under drag means a few hundred mutating DOM nodes per
 * frame in SVG, versus one element here with a devicePixelRatio transform.
 *
 * The loop stops when the layout settles and exits immediately whenever the tab goes hidden — it
 * does not idle armed in the background waiting to be re-heated. A workbench left open in a
 * background tab must not keep a core busy.
 */
/**
 * A filled head at the target end of an edge.
 *
 * Direction is knowledge here, not decoration. `works_on` and `relates_to` both point AT an anchor,
 * which is what makes a collaboration something knowledge is attached to rather than a container holding
 * it — undirected lines drew a hub, and a hub reads as a box. Nothing on this screen said which way
 * an edge went; the entity screen's relations table already did (`→`/`←`).
 *
 * ceiling: constant screen size (every length over k), tip placed just outside the target node. At a
 * few hundred nodes heads crowd where edges converge; if that becomes noise the upgrade is drawing
 * them only for the selected node's edges, not shrinking them into invisibility.
 */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  s: GraphNode,
  t: GraphNode,
  color: string,
  k: number,
) {
  const dx = (t.x ?? 0) - (s.x ?? 0);
  const dy = (t.y ?? 0) - (s.y ?? 0);
  const len = Math.hypot(dx, dy);
  // Two nodes on top of each other have no direction to draw, and normalizing would divide by ~0.
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  // On the target's rim, not its centre, or the node paints over the head.
  const back = nodeRadius(t.degree) + 1 / k;
  const tipX = (t.x ?? 0) - ux * back;
  const tipY = (t.y ?? 0) - uy * back;
  const a = 6 / k;
  const w = 2.6 / k;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * a - uy * w, tipY - uy * a + ux * w);
  ctx.lineTo(tipX - ux * a + uy * w, tipY - uy * a - ux * w);
  ctx.closePath();
  ctx.fill();
}

/**
 * The gestures, since a canvas can advertise none of them itself:
 *
 * - wheel / two-finger scroll → scrolls the PAGE, untouched. The graph is not a scroll trap.
 * - Ctrl/Cmd + wheel, trackpad pinch → zoom about the pointer.
 * - click a node → select, centre, and fetch its neighbours once.
 * - drag a node → move it; drag the background → pan the view.
 * - vertical swipe (touch) → scrolls the page; horizontal drag pans.
 *
 * Nothing on the screen SAYS any of this — the lede only mentions clicking a node — so zoom is
 * currently discoverable only by trying the modifier. A one-line hint belongs next to the legend,
 * which needs an i18n key this component cannot add.
 */
export function GraphCanvas({
  graph,
  colorOf,
  membership,
  selected,
  expanded,
  onSelect,
  onExpand,
}: {
  graph: Graph;
  colorOf: (type: string) => string;
  /** Relation types the ontology marks `membership` — drawn as not-knowledge. */
  membership: Set<string>;
  selected: string | null;
  /**
   * Which nodes have already been expanded. The PAGE owns this set, not this component: clicking a
   * node expands it, and the page's Expand button has to be able to disable itself for a node that
   * is already open — held privately here, that button could only refetch and announce it had added
   * nothing. This component reads the set to avoid re-asking.
   */
  expanded: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  // View transform lives in a ref, not state: panning and zooming must not re-render React.
  const view = useRef({ k: 1, x: 0, y: 0 });
  const dragging = useRef<GraphNode | null>(null);

  // Latest-ref mirrors of the props the main effect reads but must not rebuild on: selection
  // changes and callback identity churn on every click, and rebuilding the simulation for that
  // reheats it (sim.alpha(0.9)) and burns a core for seconds per click.
  const colorOfRef = useRef(colorOf);
  colorOfRef.current = colorOf;
  const membershipRef = useRef(membership);
  membershipRef.current = membership;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Filled by the main effect with its `draw` closure, so a selection-only change can repaint
  // without going through that effect at all.
  const drawRef = useRef<(() => void) | null>(null);
  const clickStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const panStart = useRef<{
    x: number;
    y: number;
    viewX: number;
    viewY: number;
  } | null>(null);

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
        const stroke =
          l.type === "conflicts_with"
            ? "rgba(220,60,60,0.75)"
            : "rgba(130,138,150,0.45)";
        ctx.strokeStyle = stroke;
        // Dashed = this edge is not knowledge. Authorship metadata, or a roster edge the ontology
        // marks `membership` — exactly the two an anchored briefing skips (core/inject.ts), so the
        // picture and the briefing agree about what counts.
        ctx.setLineDash(
          l.type === "authored_by" || membershipRef.current.has(l.type)
            ? [3 / k, 3 / k]
            : [],
        );
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.stroke();
        drawArrow(ctx, s, t, stroke, k);
      }
      ctx.setLineDash([]);

      for (const n of graph.nodes) {
        const r = nodeRadius(n.degree);
        const isSel = n.id === selectedRef.current;
        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
        // Status by SHAPE as well as colour: hollow+dashed draft, solid verified, faded stale,
        // grey ✕ deprecated. Colour alone would be unreadable to a meaningful share of people.
        ctx.globalAlpha = n.status === "stale" ? 0.45 : 1;
        if (n.status === "draft") {
          ctx.fillStyle = "transparent";
          ctx.strokeStyle = colorOfRef.current(n.type);
          ctx.lineWidth = 1.6 / k;
          ctx.setLineDash([2.5 / k, 2.5 / k]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (n.status === "deprecated") {
          ctx.fillStyle = "rgba(140,140,150,0.5)";
          ctx.fill();
        } else {
          ctx.fillStyle = colorOfRef.current(n.type);
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
      // Hidden tab: exit without scheduling another frame. Chrome pauses rAF in hidden tabs anyway,
      // but resuming from a still-armed loop comes back hot; this way there is nothing to resume
      // until `resume()` explicitly restarts it on visibility.
      if (document.hidden) return;
      sim.tick();
      draw();
      // Settled and nothing being dragged → stop burning frames.
      if (sim.alpha() < 0.02 && !dragging.current) return;
      frame = requestAnimationFrame(tick);
    };
    sim.alpha(0.9);
    frame = requestAnimationFrame(tick);
    drawRef.current = draw;

    /** Restart the loop with whatever alpha the simulation already has — used when the tab
     * becomes visible again. Must not reheat: the layout was already settled or mid-drag when it
     * was hidden, and boosting alpha here would burn a core on a tab nobody touched. */
    const resume = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    /** Reheat the simulation — only for pointer interaction, which genuinely needs it hot. */
    const boost = () => {
      sim.alpha(Math.max(sim.alpha(), 0.35));
      resume();
    };
    const focus = (n: GraphNode) => {
      const k = Math.max(view.current.k, 1.7);
      view.current = { k, x: -(n.x ?? 0) * k, y: -(n.y ?? 0) * k };
      draw();
    };
    /** Ask for a node's neighbours unless they have already been fetched. Recording that it happened
     * is the page's job, not a ref in here — the Expand button it renders reads the same set. */
    const expandOnce = (n: GraphNode) => {
      if (expandedRef.current.has(n.id)) return;
      onExpandRef.current(n.id);
    };

    const onPointerDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const n = hit(x, y);
      if (n) {
        dragging.current = n;
        n.fx = n.x;
        n.fy = n.y;
        clickStart.current = { id: n.id, x, y };
        panStart.current = null;
        onSelectRef.current(n.id);
        boost();
      } else {
        clickStart.current = null;
        panStart.current = {
          x,
          y,
          viewX: view.current.x,
          viewY: view.current.y,
        };
        onSelectRef.current(null);
      }
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const n = dragging.current;
      if (n) {
        const p = toSim(x, y);
        n.fx = p.x;
        n.fy = p.y;
        boost();
        return;
      }
      const pan = panStart.current;
      if (!pan) return;
      view.current.x = pan.viewX + x - pan.x;
      view.current.y = pan.viewY + y - pan.y;
      draw();
    };
    // Shared by pointerup, pointercancel, and lostpointercapture: whichever way the browser ends
    // the interaction, the pin must be released and the drag flag cleared, or a lost pointerup
    // (pointercancel fires instead on some touch/pen paths, or capture is lost mid-drag) leaves
    // `dragging.current` set forever — tick() then never sees alpha settle with no drag, and the
    // rAF loop runs at 60fps for the rest of the tab's life.
    const endDrag = () => {
      const n = dragging.current;
      if (n) {
        // Release the pin so the layout can settle around the new position.
        n.fx = null;
        n.fy = null;
      }
      dragging.current = null;
      clickStart.current = null;
      panStart.current = null;
    };
    const onPointerUp = (e: PointerEvent) => {
      const n = dragging.current;
      const start = clickStart.current;
      endDrag();
      clickStart.current = null;
      if (!n || !start || start.id !== n.id) return;
      const rect = canvas.getBoundingClientRect();
      const moved = Math.hypot(
        e.clientX - rect.left - start.x,
        e.clientY - rect.top - start.y,
      );
      if (moved > 4) return;
      focus(n);
      expandOnce(n);
    };
    const onDoubleClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const n = hit(e.clientX - rect.left, e.clientY - rect.top);
      if (n) {
        focus(n);
        expandOnce(n);
      }
    };
    /**
     * Ctrl/Cmd + wheel zooms. A bare wheel is left alone, so the page scrolls.
     *
     * This canvas is 520px of full width, so cancelling every wheel event would trap a trackpad
     * scroll anywhere over it and leave a reader heading for the node table below hunting for the
     * strip of margin beside it. The modifier is also the platform convention — a trackpad pinch
     * arrives as a ctrl+wheel event — so pinch-to-zoom keeps working without anyone being told
     * about a key.
     *
     * preventDefault happens only on the events actually consumed — a bare wheel returns before it,
     * so the browser is never told to cancel a scroll this canvas has no interest in. The listener
     * still registers non-passive, because cancelling the ctrl+wheel is the whole point.
     */
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const before = toSim(x, y);
      const f = Math.exp(-e.deltaY * 0.0016);
      const k = Math.min(4, Math.max(0.25, view.current.k * f));
      view.current.k = k;
      view.current.x = x - w / 2 - before.x * k;
      view.current.y = y - h / 2 - before.y * k;
      const n =
        hit(x, y) ?? graph.nodes.find((n) => n.id === selectedRef.current);
      if (e.deltaY < 0 && k > 1.25 && n) expandOnce(n);
      draw();
    };
    const onResize = () => {
      ({ dpr, w, h } = resize());
      draw();
    };
    const onVisibilityChange = () => {
      // Only resume on show. Nothing to do on hide — tick() already stopped scheduling itself the
      // moment document.hidden turned true.
      if (!document.hidden) resume();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("lostpointercapture", endDrag);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop = true;
      drawRef.current = null;
      cancelAnimationFrame(frame);
      sim.stop();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("lostpointercapture", endDrag);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // Selection, colours, and the callbacks are read through refs above (kept current every
    // render), so they don't need to appear here — including them would rebuild the simulation
    // and reheat it (sim.alpha(0.9)) on every click. Only `graph` is structural.
  }, [graph]);

  // A selection change needs one repaint, not a rebuilt simulation — draw() reads selectedRef, so
  // `selected` isn't used in the body, only as the trigger to redraw. Same shape as useAsync's nonce.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explained directly above.
  useEffect(() => {
    drawRef.current?.();
  }, [selected]);

  // The ontology arrives on its own request, so `membership` is usually empty for the first paint —
  // one repaint when it lands. Its own effect rather than a second dep above: `selected` never
  // shares a dependency array, and a guard enforces that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read through membershipRef, above.
  useEffect(() => {
    drawRef.current?.();
  }, [membership]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: 520,
        display: "block",
        cursor: "grab",
        // pan-y, not none: a vertical swipe is the page's, so a touch reader can scroll past 520px of
        // canvas to the node table. Everything else stays the canvas's — a horizontal drag pans the
        // view and a drag that starts on a node moves it, and when the browser claims a gesture
        // mid-drag it fires pointercancel, which endDrag already handles.
        touchAction: "pan-y",
      }}
      // Out of the accessibility tree AND out of the tab order: a canvas can take focus, and
      // aria-hidden on a focusable element strands screen-reader users on an element they cannot
      // perceive. The node list below the canvas is the accessible path to the same data.
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
