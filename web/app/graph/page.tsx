"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import {
  type Graph,
  MAX_NODES,
  makeTypeColors,
  membershipTypes,
  mergeGraph,
  toGraph,
  truncationNotice,
} from "../../lib/graph";
import { useT } from "../../lib/i18n";
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

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
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

  const expand = useCallback(async (id: string) => {
    try {
      const more = await api.graph({ scope: id, depth: 1, limit: MAX_NODES });
      setGraph((g) => (g ? mergeGraph(g, more) : toGraph(more)));
    } catch (e) {
      setError(e);
    }
  }, []);

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
  const t = useT();
  const notice = graph ? truncationNotice(graph) : null;
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
      {notice && (
        <div className="banner" data-kind="warn">
          {notice}
        </div>
      )}

      <div className="controls">
        {anchor && (
          <Link className="btn" href="/graph/">
            {t.graph.wholeNamespace}
          </Link>
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
      </div>

      <div className="panel">
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
                <Button type="button" onClick={() => expand(chosen.id)}>
                  {t.common.expand}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          {t.graph.nodes}
          <span className="muted">{t.graph.nodesNote}</span>
        </div>
        {graph && graph.nodes.length > 0 ? (
          <div className="scroll-x">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.common.type}</TableHead>
                  <TableHead>{t.common.record}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
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
                    <TableCell className="num">{n.degree}</TableCell>
                    <TableCell>
                      <Button type="button" onClick={() => expand(n.id)}>
                        {t.common.expand}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={nodePage.page}
              pages={nodePage.pages}
              setPage={nodePage.setPage}
              total={sortedNodes.length}
            />
          </div>
        ) : (
          <div className="empty">none</div>
        )}
      </div>
    </>
  );
}

export default function GraphPage() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <GraphBody />
    </Suspense>
  );
}
