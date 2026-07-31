"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
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
  const t = useT();
  return (
    <>
      <h1>{t.inject.heading}</h1>
      <p className="lede">
        {t.inject.ledeBefore}
        <code>yoke_inject</code>
        {t.inject.ledeAfter}
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
          placeholder={t.inject.queryPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="query"
          style={{ minWidth: 260 }}
        />
        <input
          placeholder={t.inject.scopePlaceholder}
          value={draftScope}
          onChange={(e) => setDraftScope(e.target.value)}
          aria-label="scope"
          className="mono"
          style={{ minWidth: 220 }}
        />
        <Button type="submit">{t.inject.run}</Button>
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={includeDraft}
            onChange={(e) => run({ draft: e.target.checked })}
          />
          {t.inject.includeDraft}
        </label>
      </form>

      {!q && !scope ? (
        <div className="panel">
          <div className="empty">{t.inject.prompt}</div>
        </div>
      ) : result.loading ? (
        <div className="panel">
          <div className="empty">{t.common.loading}</div>
        </div>
      ) : (
        <>
          {includeDraft && (
            <div className="banner" data-kind="warn">
              {t.inject.draftsIncluded}
            </div>
          )}
          <div className="panel">
            <div className="panel-head">
              {t.inject.wouldBeInjected}
              <span className="muted">{items.length}</span>
              {result.data?.scope && (
                <span className="muted mono">
                  {t.inject.scopeNote(result.data.scope)}
                </span>
              )}
            </div>
            {/* A preview that silently showed 50 of 312 would misrepresent what an agent receives —
                which is this screen's whole job. */}
            {(result.data?.omitted ?? 0) > 0 && (
              <div className="banner" data-kind="warn">
                {t.inject.truncated(
                  items.length,
                  items.length + (result.data?.omitted ?? 0),
                )}
              </div>
            )}
            <KnowledgeTable rows={items} empty={t.inject.empty} />
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
