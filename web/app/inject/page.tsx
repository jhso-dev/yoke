"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

/**
 * What an agent would actually receive.
 *
 * This is the screen that makes the injection filter observable instead of theoretical: the server
 * runs the real inject(), so what is listed here is byte-for-byte what MCP would hand an agent for
 * the same query. It is also why this is not the search UI WEB-UI.md refuses — it renders the
 * injection decision, in ranked order, with citations, and no prose. Every look is audited as
 * `inject_preview`.
 */
function InjectBody() {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get("q") ?? "";
  const scope = params.get("scope") ?? "";
  const includeDraft = params.get("draft") === "1";
  const [draft, setDraft] = useState(q);
  const [draftScope, setDraftScope] = useState(scope);

  const result = useAsync(
    () =>
      q || scope
        ? api.inject({
            q: q || undefined,
            scope: scope || undefined,
            includeDraft,
            limit: 50,
          })
        : Promise.resolve(null),
    [q, scope, includeDraft],
  );

  const run = (next: { q?: string; scope?: string; draft?: boolean }) => {
    const u = new URLSearchParams();
    const nq = next.q ?? draft;
    const ns = next.scope ?? draftScope;
    const nd = next.draft ?? includeDraft;
    if (nq) u.set("q", nq);
    if (ns) u.set("scope", ns);
    if (nd) u.set("draft", "1");
    router.replace(`/inject/${u.toString() ? `?${u}` : ""}`);
  };

  const items = result.data?.items ?? [];
  return (
    <>
      <h1>Injection preview</h1>
      <p className="lede">
        Exactly what an agent receives for this query — same filter, same order,
        same citations as a real <code>yoke_inject</code> call. Stale and
        deprecated records never appear, whatever you ask for.
      </p>
      <ErrorBanner error={result.error} />
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          run({});
        }}
      >
        <input
          placeholder="what is the agent working on?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="query"
          style={{ minWidth: 260 }}
        />
        <input
          placeholder="scope (collaboration or person id, optional)"
          value={draftScope}
          onChange={(e) => setDraftScope(e.target.value)}
          aria-label="scope"
          className="mono"
          style={{ minWidth: 220 }}
        />
        <button type="submit" className="primary">
          preview
        </button>
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={includeDraft}
            onChange={(e) => run({ draft: e.target.checked })}
          />
          include drafts
        </label>
      </form>

      {!q && !scope ? (
        <div className="panel">
          <div className="empty">
            enter a query, or a scope on its own for that context&apos;s
            briefing
          </div>
        </div>
      ) : result.loading ? (
        <div className="panel">
          <div className="empty">loading…</div>
        </div>
      ) : (
        <>
          {includeDraft && (
            <div className="banner" data-kind="warn">
              Drafts included. An agent would <strong>not</strong> receive these
              — they are shown labelled so you can see what is waiting for
              review.
            </div>
          )}
          <div className="panel">
            <div className="panel-head">
              would be injected
              <span className="muted">{items.length}</span>
              {result.data?.scope && (
                <span className="muted mono">
                  scope: {result.data.scope} (leads, does not imprison)
                </span>
              )}
            </div>
            {/* A preview that silently showed 50 of 312 would misrepresent what an agent receives —
                which is this screen's whole job. */}
            {(result.data?.omitted ?? 0) > 0 && (
              <div className="banner" data-kind="warn">
                showing {items.length} of{" "}
                {items.length + (result.data?.omitted ?? 0)} — an agent gets the
                same page, plus a note telling it to ask a specific question for
                the rest. Raise the limit to preview more.
              </div>
            )}
            <KnowledgeTable
              rows={items}
              empty="nothing verified matches — an agent would get nothing for this query"
            />
          </div>
        </>
      )}
    </>
  );
}

export default function Inject() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <InjectBody />
    </Suspense>
  );
}
