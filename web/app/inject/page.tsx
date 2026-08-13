"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { CopyCode } from "../../components/CopyCode";
import { DateTimePicker } from "../../components/DateTimePicker";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { Panel, PanelHead } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { isoFromLocalInput, localTime } from "../../lib/time";
import type { InjectedKnowledge } from "../../lib/types";
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
      <ErrorBanner error={result.error} onRetry={result.reload} />
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          run({});
        }}
      >
        <Input
          placeholder={t.inject.queryPlaceholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t.common.query}
          className="w-auto min-w-65"
        />
        <Input
          placeholder={t.inject.scopePlaceholder}
          value={draftScope}
          onChange={(e) => setDraftScope(e.target.value)}
          aria-label={t.inject.scopePlaceholder}
          className="mono w-auto min-w-55"
        />
        <Button type="submit">{t.inject.run}</Button>
      </form>
      {/* The QUERY row above, the LENS row here: what to ask, then under which reading — drafts in
          or out, and as of when. Filters act immediately, so they need no seat next to the submit.
          Labels sit BESIDE their control, never around it: a label that wraps the control it also
          points at (htmlFor) makes some engines activate it twice per click — the two toggles cancel
          and the checkbox reads as dead. */}
      <div className="controls">
        <span className="flex items-center gap-1.5">
          <Checkbox
            id="inject-include-draft"
            checked={includeDraft}
            onCheckedChange={(v) => run({ draft: v === true })}
          />
          <Label
            htmlFor="inject-include-draft"
            className="text-[inherit] font-[inherit]"
          >
            {t.inject.includeDraft}
          </Label>
        </span>
        <Separator orientation="vertical" />
        <span className="flex items-center gap-1.5">
          <Label
            htmlFor="inject-as-of"
            className="text-[inherit] font-[inherit]"
          >
            {t.inject.asOf}
          </Label>
          <DateTimePicker
            id="inject-as-of"
            value={asOfLocal}
            onChange={(next) => run({ asOf: next })}
            title={t.inject.asOfHint}
            // Unset MEANS the present on this screen, so both the empty trigger and the in-popover
            // reset say so — one control, one place to operate it, no twin button beside it.
            unsetLabel={t.inject.asOfClear}
            resetLabel={t.inject.asOfClear}
            // An as-of read looks BACK. Nothing clamps a future instant server-side, so without this
            // the screen would announce a historical view over a query that ran against now.
            disableFuture
          />
        </span>
      </div>

      {!q && !scope ? (
        <Panel>
          <div className="empty">{t.inject.prompt}</div>
        </Panel>
      ) : result.loading && !result.data ? (
        <Panel>
          <div className="empty">{t.common.loading}</div>
        </Panel>
      ) : (
        <>
          {includeDraft && (
            <Alert variant="warn">{t.inject.draftsIncluded}</Alert>
          )}
          {/* Flagged from the SERVER's echo, not from the local field: if the two ever disagree, what
              matters is which clock actually produced these rows. A historical result that read as a
              current one would be worse than not offering the view at all. */}
          {result.data?.asOf && (
            <Alert variant="warn">
              {t.inject.asOfActive(localTime(result.data.asOf))}
              <br />
              <span className="muted">{t.inject.asOfCeiling}</span>
            </Alert>
          )}
          <Panel>
            <PanelHead>
              {t.inject.wouldBeInjected}
              <span className="muted">{items.length}</span>
              {result.data?.scope && (
                <span className="muted mono">
                  {t.inject.scopeNote(result.data.scope)}
                </span>
              )}
            </PanelHead>
            {/* A preview that silently showed 50 of 312 would misrepresent what an agent receives —
                which is this screen's whole job. */}
            {(result.data?.omitted ?? 0) > 0 && (
              <Alert variant="warn">
                {t.inject.truncated(
                  items.length,
                  items.length + (result.data?.omitted ?? 0),
                )}
              </Alert>
            )}
            {/* Name what was held back and why — on a full page as much as an empty one. This screen
                answers "what will my agent receive", and a reader shown ten records has no other way
                to learn that the one answering their question is past its freshness window. */}
            {result.data?.withheld && (
              <Alert variant="warn">
                {t.inject.withheld(result.data.withheld, items.length)}
              </Alert>
            )}
            <KnowledgeTable
              rows={items}
              empty={t.inject.empty}
              paginate
              // A disputed row has to LOOK disputed. The conflicts screen one page over already listed
              // these pairs; this screen claims to show what an agent receives, and the agent now
              // receives the marker — without it two records that flatly disagree render as two
              // ordinary rows. A link rather than the id, per the rule that a person never reads a ULID.
              trailing={{
                head: t.inject.disputedHead,
                cell: (r) => {
                  const others =
                    (r as InjectedKnowledge).conflictsWith ?? undefined;
                  if (!others) return null;
                  return (
                    <span className="flex flex-wrap gap-2">
                      {others.map((id) => (
                        <Link
                          key={id}
                          href={`/entity/?id=${encodeURIComponent(id)}`}
                          title={id}
                        >
                          {t.inject.disputedBy}
                        </Link>
                      ))}
                    </span>
                  );
                },
              }}
            />
          </Panel>
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
