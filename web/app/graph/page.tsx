"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Actor } from "../../components/Actor";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GraphCanvas } from "../../components/GraphCanvas";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import {
  type Graph,
  MAX_NODES,
  makeTypeColors,
  membershipTypes,
  mergeGraph,
  toGraph,
  truncationCounts,
} from "../../lib/graph";
import { useT } from "../../lib/i18n";
import { announce } from "../../lib/toast";
import { useAsync } from "../../lib/useAsync";

/**
 * The knowledge graph, navigable.
 *
 * What it is for: seeing the shape of what is stored — clusters, orphans, contradiction pairs, what a
 * scope anchor would actually pull in. Not for reading knowledge; clicking through to a record is.
 *
 * Canvas is opaque to screen readers, so the same nodes are also rendered as a keyboard-navigable
 * list below. That list is not a consolation prize — it is the faster way to reach a specific record.
 */
function GraphBody() {
  const anchor = useSearchParams().get("scope") ?? "";
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Which nodes have had their neighbours fetched. Lifted out of GraphCanvas, which kept it in a
  // private ref: clicking a node already expands it, so the Expand button that then appears in the
  // detail row for that same node could only refetch and announce that it added nothing. State
  // rather than a ref because the button's `disabled` is rendered from it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // A new anchor draws a new graph, so nothing in it has been expanded yet — carrying the old set
    // over would disable Expand on a node whose neighbours this graph has never asked for.
    setExpanded(new Set());
    api
      .graph({
        limit: MAX_NODES,
        scope: anchor || undefined,
        depth: anchor ? 2 : undefined,
      })
      .then((d) => {
        if (!alive) return;
        setGraph(toGraph(d));
        setSelected(anchor || null);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [anchor]);

  const t = useT();
  // Expanding says what it did, because for a long time it did not. A node's neighbours are often
  // already on screen — the highest-degree node in this corpus is the account that authored 40 visible
  // records, so expanding the FIRST row of the node table adds exactly nothing — and 25 new nodes among
  // 200 is easy to miss even when it worked. A silent no-op reads as a broken button. The rest of this
  // product refuses to be silent about what it withheld (`omitted`, the truncation banners); this is
  // the same rule applied to what it added.
  const expand = useCallback(
    async (id: string) => {
      // Recorded before the request so a second click cannot queue a second fetch of the same
      // neighbourhood, and rolled back below if it fails — a failed expansion must stay retryable.
      setExpanded((prev) => new Set(prev).add(id));
      try {
        const more = await api.graph({ scope: id, depth: 1, limit: MAX_NODES });
        setGraph((g) => {
          if (!g) return toGraph(more);
          const merged = mergeGraph(g, more);
          const nodes = merged.nodes.length - g.nodes.length;
          const links = merged.links.length - g.links.length;
          announce(
            nodes || links
              ? t.graph.expanded(nodes, links)
              : t.graph.expandedNothing,
          );
          return merged;
        });
      } catch (e) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setError(e);
      }
    },
    [t],
  );

  const types = useMemo(
    () => [...new Set(graph?.nodes.map((n) => n.type) ?? [])].sort(),
    [graph],
  );
  const colorOf = useMemo(() => makeTypeColors(types), [types]);
  // Fetched only for what `membership: true` means to the drawing — a roster edge is not knowledge.
  // Its failure is cosmetic, so it deliberately has no ErrorBanner: an unreachable ontology must not
  // blank a graph that loaded fine.
  const ontology = useAsync(() => api.ontology(), []);
  const membership = useMemo(
    () => membershipTypes(ontology.data ?? []),
    [ontology.data],
  );
  // lib/graph.ts returns the two numbers; the sentence about them is the dictionary's, so a Korean
  // reader gets a Korean Alert.
  const cut = graph ? truncationCounts(graph) : null;
  const chosen = graph?.nodes.find((n) => n.id === selected) ?? null;
  const sortedNodes = useMemo(
    () => [...(graph?.nodes ?? [])].sort((a, b) => b.degree - a.degree),
    [graph],
  );
  const nodePage = usePage(sortedNodes);

  return (
    <>
      <h1>{t.graph.heading}</h1>
      <p className="lede">{anchor ? t.graph.ledeAnchored : t.graph.lede}</p>
      <ErrorBanner error={error} />
      {cut && (
        <Alert variant="warn">
          {t.graph.truncated(cut.shown, cut.offered)}
        </Alert>
      )}

      <div className="controls">
        {anchor && (
          <Button
            asChild
            variant="secondary"
            className="border border-border hover:border-primary"
          >
            <Link href="/graph/">{t.graph.wholeNamespace}</Link>
          </Button>
        )}
        <span className="muted">
          {t.graph.counts(graph?.nodes.length ?? 0, graph?.links.length ?? 0)}
        </span>
        {types.map((t) => (
          <Badge key={t} variant="plain">
            <span
              aria-hidden="true"
              style={{
                width: 9,
                height: 9,
                borderRadius: 999,
                background: colorOf(t),
                display: "inline-block",
              }}
            />
            {t}
          </Badge>
        ))}
        {/* Without this the two edge marks are decoration. The direction is the point: knowledge and
            people point AT the work, which is why an anchor gathers knowledge instead of holding it. */}
        <span className="muted">{t.graph.legend}</span>
        {/* Said out loud because the gesture changed: a bare wheel over the canvas now scrolls the
            page (it used to zoom, trapping anyone trying to reach the table below), so zoom moved
            behind a modifier and would otherwise be discoverable only by accident. */}
        <span className="muted">{t.graph.zoomHint}</span>
      </div>

      {/* Was `.panel`, which globals.css marks as migration debt. The overrides are what `.panel` gave
          this box for free: no card padding or row gap (the canvas paints edge to edge and the detail
          row brings its own), this product's 6px radius rather than shadcn's larger one, and no
          shadow. `overflow-hidden` stays because the canvas DOES paint to the edge — without it its
          square corners sit over the card's rounded ones. */}
      <Panel>
        {loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : !graph || graph.nodes.length === 0 ? (
          <div className="empty">{t.graph.empty}</div>
        ) : (
          <>
            <GraphCanvas
              graph={graph}
              colorOf={colorOf}
              membership={membership}
              selected={selected}
              expanded={expanded}
              onSelect={setSelected}
              onExpand={expand}
            />
            {chosen && (
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "10px 12px",
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <StatusBadge status={chosen.status} />
                <span className="mono">{chosen.type}</span>
                <strong>{chosen.label}</strong>
                <Actor actor={chosen.actor} actorName={chosen.actorName} />
                <Citation row={chosen} />
                <Link href={`/entity/?id=${encodeURIComponent(chosen.id)}`}>
                  {t.common.openRecord}
                </Link>
                {/* Disabled once this node's neighbours are in: selecting a node expands it, so the
                    button appeared already spent — it refetched, merged nothing, and announced
                    "already drawn". Disabled says that before the click instead of after. */}
                <Button
                  type="button"
                  disabled={expanded.has(chosen.id)}
                  onClick={() => expand(chosen.id)}
                >
                  {t.common.expand}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      {/* Same conversion as the card above; `mt-[14px]` is the gap `.panel + .panel` used to give a
          stacked pair, and the pager is inset from the sides the way `.panel > .controls` did it. */}
      <Panel>
        {/* `.panel-head`'s box, kept dense: 9px/12px padding, 13px semibold, the secondary fill and
            the hairline under it. Two columns rather than CardHeader's two rows, because the note
            reads as a continuation of the title and not as a line under it.
            `border-b-[1px]` and not `border-b`: CardHeader carries `[.border-b]:pb-6`, which compiles
            to `:is(.border-b)` and would silently pad this head out to a marketing card's 24px. */}
        <PanelHead>
          <CardTitle className="text-[13px]">{t.graph.nodes}</CardTitle>
          <span className="muted">{t.graph.nodesNote}</span>
        </PanelHead>
        {graph && graph.nodes.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.type}</TableHead>
                  <TableHead>{t.common.record}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
                  <TableHead>{t.common.source}</TableHead>
                  <TableHead>{t.common.relations}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodePage.items.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="mono">{n.type}</TableCell>
                    <TableCell>
                      <Link href={`/entity/?id=${encodeURIComponent(n.id)}`}>
                        {n.label}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={n.status} />
                    </TableCell>
                    <TableCell>
                      <Citation row={n} />
                    </TableCell>
                    <TableCell className="num">{n.degree}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        disabled={expanded.has(n.id)}
                        onClick={() => expand(n.id)}
                      >
                        {t.common.expand}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {/* A sibling of <Table>, not a child of it: Table renders its OWN `overflow-x-auto`
                container, and the pager used to sit inside that box together with the six columns —
                so on a narrow viewport the Next button scrolled sideways out of view. The `.scroll-x`
                wrapper that held both is gone for the same reason: it duplicated Table's container. */}
            <Pagination
              page={nodePage.page}
              pages={nodePage.pages}
              setPage={nodePage.setPage}
              total={sortedNodes.length}
            />
          </>
        ) : (
          <div className="empty">{t.common.none}</div>
        )}
      </Panel>
    </>
  );
}

export default function GraphPage() {
  const t = useT();
  return (
    <Suspense fallback={<p className="muted">{t.common.loading}</p>}>
      <GraphBody />
    </Suspense>
  );
}
