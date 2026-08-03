"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { isoFromLocalInput, localTime } from "../../lib/time";
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
  // The control's own vocabulary is local wall time (`2026-07-30T16:43`) and that is what stays in the
  // URL, so a shared link reopens the same field. The ISO instant is derived at request time — the
  // audit screen learned the hard way that round-tripping ISO through `value` blanks the field.
  const asOfLocal = params.get("asOf") ?? "";
  const asOf = isoFromLocalInput(asOfLocal);
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
            asOf: asOf || undefined,
          })
        : Promise.resolve(null),
    [q, scope, includeDraft, asOf],
  );

  const run = (next: {
    q?: string;
    scope?: string;
    draft?: boolean;
    asOf?: string;
  }) => {
    const u = new URLSearchParams();
    const nq = next.q ?? draft;
    const ns = next.scope ?? draftScope;
    const nd = next.draft ?? includeDraft;
    const na = next.asOf ?? asOfLocal;
    if (nq) u.set("q", nq);
    if (ns) u.set("scope", ns);
    if (nd) u.set("draft", "1");
    if (na) u.set("asOf", na);
    router.replace(`/inject/${u.toString() ? `?${u}` : ""}`);
  };

  const items = result.data?.items ?? [];
  const t = useT();
  return (
    <>
      <h1>{t.inject.heading}</h1>
      <p className="lede">
        {t.inject.ledeBefore}
        <CopyCode value="yoke_inject" />
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
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {t.inject.asOf}
          <input
            type="datetime-local"
            value={asOfLocal}
            onChange={(e) => run({ asOf: e.target.value })}
            aria-label="asOf"
            title={t.inject.asOfHint}
          />
        </label>
        {asOfLocal && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => run({ asOf: "" })}
          >
            {t.inject.asOfClear}
          </Button>
        )}
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
          {/* Flagged from the SERVER's echo, not from the local field: if the two ever disagree, what
              matters is which clock actually produced these rows. A historical result that read as a
              current one would be worse than not offering the view at all. */}
          {result.data?.asOf && (
            <div className="banner" data-kind="warn">
              {t.inject.asOfActive(localTime(result.data.asOf))}
              <br />
              <span className="muted">{t.inject.asOfCeiling}</span>
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
            <KnowledgeTable rows={items} empty={t.inject.empty} paginate />
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
