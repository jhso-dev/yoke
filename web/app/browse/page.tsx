"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreateButton } from "../../components/CreateButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { Knowledge, Page, SearchResult } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** Radix Select reserves the empty string for "no selection", so an "all"/"any" option cannot BE the
 * empty value it means — it carries this token and the handler maps it back. The filter state stays
 * `""` so the URL and the API call are unchanged. */
const ANY = "__any";

/**
 * Enumerate what is stored, and search it.
 *
 * Enumeration shows the shape of the corpus — what types exist, what is still draft, what has gone
 * stale — so a human can govern it. The text box narrows that to matching records, and stays on the
 * governing side of WEB-UI.md's line by construction:
 *
 * - it calls the storage port's own `search()`, the one `inject` falls back to, so there is no
 *   second ranker in the product;
 * - results come back through the same `KnowledgeTable` as the listing, so a draft hit reads as a
 *   draft rather than as an answer;
 * - it is a bounded top-N with no cursor, and says so when the cap bites.
 *
 * Asking questions *of* the knowledge is still the AI's job over MCP. This finds records.
 */
function BrowseBody() {
  const params = useSearchParams();
  const router = useRouter();
  const type = params.get("type") ?? "";
  const status = params.get("status") ?? "";
  const query = params.get("q") ?? "";
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  // What the box shows while you type. Separate from `query`, which is what has been submitted —
  // firing a request per keystroke would write an audit row per keystroke, and the trail would
  // record fragments nobody searched for.
  const [draft, setDraft] = useState(query);

  const defs = useAsync(() => api.ontology(), []);
  // One of two sources, never both: with text it is `search` (ranked by the port, bounded, no
  // cursor), without it the enumeration. Keeping the cursor out of the search path is deliberate —
  // `search` has no `after`, so a stale cursor could not be honoured and would silently do nothing.
  const page = useAsync<SearchResult | Page<Knowledge>>(
    () =>
      query
        ? api.search({
            q: query,
            type: type || undefined,
            status: status || undefined,
          })
        : api.entities({
            type: type || undefined,
            status: status || undefined,
            after,
            limit: 50,
          }),
    [query, type, status, after],
  );

  const setFilter = (next: { type?: string; status?: string; q?: string }) => {
    const p = new URLSearchParams();
    const t = next.type ?? type;
    const s = next.status ?? status;
    const q = next.q ?? query;
    if (t) p.set("type", t);
    if (s) p.set("status", s);
    if (q) p.set("q", q);
    setCursors([]); // a new filter restarts paging; keeping a cursor would skip rows
    router.replace(`/browse/${p.toString() ? `?${p}` : ""}`);
  };

  const t = useT();
  const rows = page.data?.items ?? [];
  // The two sources return different shapes, so narrow once and let both the banner and its number
  // read off the same value — `truncated` and `limit` only exist on the search arm.
  const found =
    query && page.data && "truncated" in page.data ? page.data : null;
  return (
    <>
      <div className="page-head">
        <h1>{t.browse.heading}</h1>
        <CreateButton ontology={defs.data ?? []} onCreated={page.reload} />
      </div>
      <p className="lede">{t.browse.lede}</p>
      <ErrorBanner error={page.error ?? defs.error} />
      <div className="controls">
        <Select
          value={type || ANY}
          onValueChange={(v) => setFilter({ type: v === ANY ? "" : v })}
        >
          <SelectTrigger aria-label="type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.browse.allTypes}</SelectItem>
            {(defs.data ?? [])
              .filter((d) => d.kind === "entity")
              .map((d) => (
                <SelectItem key={d.name} value={d.name}>
                  {d.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select
          value={status || ANY}
          onValueChange={(v) => setFilter({ status: v === ANY ? "" : v })}
        >
          <SelectTrigger aria-label="status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t.browse.anyStatus}</SelectItem>
            <SelectItem value="draft">draft</SelectItem>
            <SelectItem value="verified">verified</SelectItem>
            <SelectItem value="deprecated">deprecated</SelectItem>
          </SelectContent>
        </Select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilter({ q: draft.trim() });
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t.browse.search}
            title={t.browse.searchHint}
            aria-label="search"
            className="w-auto min-w-60"
          />
          {query && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDraft("");
                setFilter({ q: "" });
              }}
            >
              {t.browse.clear}
            </Button>
          )}
        </form>
        <span className="muted">
          {t.browse.shown(rows.length, !!page.data?.next)}
        </span>
        {/* 'stale' is absent on purpose: it is computed at read time and never stored, so it cannot
            be a stored-status filter. It still shows in the status column. */}
      </div>
      {/* Never a silent cap. The listing says "more available" through its cursor; search has no
          cursor, so the cap has to be said in words. */}
      {found?.truncated && (
        <Alert variant="warn">{t.browse.searchTruncated(found.limit)}</Alert>
      )}
      <div className="panel">
        {page.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : (
          <KnowledgeTable
            rows={rows}
            empty={query ? t.browse.noSearchMatch : t.browse.noMatch}
          />
        )}
      </div>
      {/* Hidden while searching, rather than disabled: `search` takes no cursor, so a Next here
          would be a control that cannot do anything. */}
      <div
        className="controls"
        style={{ marginTop: 12, display: query ? "none" : undefined }}
      >
        <Button
          type="button"
          variant="secondary"
          disabled={cursors.length === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          <ChevronLeftIcon />
          {t.common.prev}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!page.data?.next}
          onClick={() =>
            setCursors((c) => (page.data?.next ? [...c, page.data.next] : c))
          }
        >
          {t.common.next}
          <ChevronRightIcon />
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
