"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { CreateButton } from "../../components/CreateButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

/**
 * Enumerate what is stored.
 *
 * This is reachability, not retrieval: it shows the shape of the corpus — what types exist, what is
 * still draft, what has gone stale — so a human can govern it. It is not a search box for reading
 * knowledge; that boundary is drawn in WEB-UI.md, and asking questions of the knowledge is the AI's
 * job over MCP.
 */
function BrowseBody() {
  const params = useSearchParams();
  const router = useRouter();
  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "";
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);

  const defs = useAsync(() => api.ontology(), []);
  const page = useAsync(
    () =>
      api.entities({
        type: type || undefined,
        status: status || undefined,
        after,
        limit: 50,
      }),
    [type, status, after],
  );

  const setFilter = (next: { type?: string; status?: string }) => {
    const q = new URLSearchParams();
    const t = next.type ?? type;
    const s = next.status ?? status;
    if (t) q.set("type", t);
    if (s) q.set("status", s);
    setCursors([]); // a new filter restarts paging; keeping a cursor would skip rows
    router.replace(`/browse/${q.toString() ? `?${q}` : ""}`);
  };

  const rows = page.data?.items ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Browse</h1>
        <CreateButton ontology={defs.data ?? []} onCreated={page.reload} />
      </div>
      <p className="lede">
        Every record in this namespace, newest last. Use it to see the shape of
        what you have — orphans, stale corners, drafts nobody reviewed.
      </p>
      <ErrorBanner error={page.error ?? defs.error} />
      <div className="controls">
        <select
          value={type}
          onChange={(e) => setFilter({ type: e.target.value })}
          aria-label="type"
        >
          <option value="">all types</option>
          {(defs.data ?? [])
            .filter((d) => d.kind === "entity")
            .map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
        </select>
        <select
          value={status}
          onChange={(e) => setFilter({ status: e.target.value })}
          aria-label="status"
        >
          <option value="">any status</option>
          <option value="draft">draft</option>
          <option value="verified">verified</option>
          <option value="deprecated">deprecated</option>
        </select>
        <span className="muted">
          {rows.length} shown{page.data?.next ? " (more available)" : ""}
        </span>
        {/* 'stale' is absent on purpose: it is computed at read time and never stored, so it cannot
            be a stored-status filter. It still shows in the status column. */}
      </div>
      <div className="panel">
        {page.loading ? (
          <div className="empty">loading…</div>
        ) : (
          <KnowledgeTable rows={rows} empty="nothing matches that filter" />
        )}
      </div>
      <div className="controls" style={{ marginTop: 12 }}>
        <Button
          type="button"
          disabled={cursors.length === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          ← previous
        </Button>
        <Button
          type="button"
          disabled={!page.data?.next}
          onClick={() =>
            setCursors((c) => (page.data?.next ? [...c, page.data.next] : c))
          }
        >
          next →
        </Button>
      </div>
    </>
  );
}

export default function Browse() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <BrowseBody />
    </Suspense>
  );
}
