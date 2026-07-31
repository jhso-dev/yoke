"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Actor } from "../../components/Actor";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GraphCanvas } from "../../components/GraphCanvas";
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
          <span key={t} className="pill" style={{ background: "transparent" }}>
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
          </span>
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
            <table>
              <thead>
                <tr>
                  <th>{t.common.type}</th>
                  <th>{t.common.record}</th>
                  <th>{t.common.status}</th>
                  <th>{t.common.relations}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...graph.nodes]
                  .sort((a, b) => b.degree - a.degree)
                  .map((n) => (
                    <tr key={n.id}>
                      <td className="mono">{n.type}</td>
                      <td>
                        <Link href={`/entity/?id=${encodeURIComponent(n.id)}`}>
                          {n.label}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={n.status} />
                      </td>
                      <td className="num">{n.degree}</td>
                      <td>
                        <Button type="button" onClick={() => expand(n.id)}>
                          {t.common.expand}
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
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
