"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Citation } from "../../components/Citation";
import { CopyCode } from "../../components/CopyCode";
import { CreateButton } from "../../components/CreateButton";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { Panel, PanelHead } from "../../components/Panel";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import type { InjectedKnowledge, Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * What one person's recorded judgment would inject.
 *
 * Citation, not impersonation: this lists that person's own records with their sources. It never
 * synthesizes prose in their voice — the AI does that over MCP, from these same records.
 *
 * Two views on one route, because a ULID cannot be a static path (`generateStaticParams` has nothing
 * to enumerate): `/persona/` is the roster, `/persona/?id=…` is one person. The roster is a card
 * grid rather than a <select>, which would hide every person behind a click and say nothing about
 * them until you picked one.
 */

/** A page of the roster. Sized so a card grid fills a screen without a second request. */
const PER_PAGE = 24;

function Roster() {
  const t = useT();
  // The same keyset-cursor stack browse uses: a list of `after` values, so Previous is a pop rather
  // than a backwards query the port has no way to answer.
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors.at(-1);
  const page = useAsync(
    () => api.entities({ type: "person", after, limit: PER_PAGE }),
    [after],
  );
  // For the create form's fields — a tenant that added attributes to `person` gets them here too.
  const ontology = useAsync(() => api.ontology(), []);
  const rows = page.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <h1>{t.persona.heading}</h1>
        {/* A persona is a derivative, never a stored artifact (VISION): what this actually records
            is the person the persona anchors to, so the form is the person type's. */}
        <CreateButton
          ontology={ontology.data ?? []}
          type="person"
          label={t.persona.newPersona}
          onCreated={page.reload}
        />
      </div>
      <p className="lede">{t.persona.lede}</p>
      <ErrorBanner error={page.error} onRetry={page.reload} />
      {page.loading && !page.data ? (
        <Panel>
          <div className="empty">{t.common.loading}</div>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <div className="empty">{t.persona.emptyList}</div>
        </Panel>
      ) : (
        <div className="cards">
          {rows.map((p) => (
            // The whole card is the link, so the click target is the card and not just its title.
            <Link
              key={p.id}
              href={`/persona/?id=${encodeURIComponent(p.id)}`}
              className="card-link persona-card"
            >
              {/* Tighter than shadcn's default card padding, to sit in the same density as the
                  tables on every other screen. */}
              <Card className="h-full gap-3 py-4">
                <CardHeader className="gap-2 px-4">
                  <CardTitle>{recordLabel(p)}</CardTitle>
                  {/* A grid item stretches across its column whatever its display, so the badge
                      needs telling to be its own width — otherwise it draws as a full-width bar. */}
                  <div className="justify-self-start">
                    <StatusBadge status={p.effectiveStatus} />
                  </div>
                </CardHeader>
                {/* No record count on the card: the list payload carries `summary`, not a tally,
                    and one persona query per card to print a number would be an N+1 for a number
                    nobody acts on. The count is on the person's own page. */}
                <CardContent className="px-4">
                  <Citation row={p} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <div className="controls" style={{ marginTop: 12 }}>
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

function Person({ id }: { id: string }) {
  const t = useT();
  const [query, setQuery] = useState("");
  // Two requests, and they answer different questions: `persona` is the injection (audited as such),
  // `who` is the person record it is about — the roster is not on screen to supply a name, and a
  // deep link never had one.
  const who = useAsync(() => api.entity(id), [id]);
  const persona = useAsync(() => api.persona(id), [id]);

  // Searching the loaded set, not the namespace. That is the honest scope for this box: everything
  // this person authored is already here, so there is no page 3 for a match to hide on.
  const hit = (s: string) =>
    !query || s.toLowerCase().includes(query.toLowerCase());
  const allDecisions = persona.data?.decisions ?? [];
  const allFacts = persona.data?.facts ?? [];
  const decisions = allDecisions.filter((d) => hit(d.summary));
  const facts = allFacts.filter((f) => hit(f.summary));
  const total = allDecisions.length + allFacts.length;
  const shown = decisions.length + facts.length;

  const name = who.data ? recordLabel(who.data.entity) : "";

  // A disputed row has to LOOK disputed here too. Both sides of a live `conflicts_with` are part of
  // this person's records, and rendering them as two ordinary rows shows an open disagreement as their
  // settled position — the same defect the inject preview fixed, on the screen where the reader is
  // most likely to read a row as "this is what they think". Same column, same words as that screen.
  const disputedColumn = {
    head: t.inject.disputedHead,
    cell: (r: Knowledge) => {
      const others = (r as InjectedKnowledge).conflictsWith;
      if (!others) return null;
      return (
        <span className="flex flex-wrap gap-2">
          {others.map((cid) => (
            <Link
              key={cid}
              href={`/entity/?id=${encodeURIComponent(cid)}`}
              title={cid}
            >
              {t.inject.disputedBy}
            </Link>
          ))}
        </span>
      );
    },
  };

  return (
    <>
      <h1>{name || t.persona.headingOne}</h1>
      <p className="lede">
        {who.data && <StatusBadge status={who.data.entity.effectiveStatus} />}{" "}
        <Link href="/persona/">{t.persona.all}</Link>
      </p>
      <ErrorBanner
        error={who.error ?? persona.error}
        onRetry={() => {
          who.reload();
          persona.reload();
        }}
      />

      <div className="controls">
        <Input
          placeholder={t.persona.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t.common.search}
          className="w-auto min-w-65"
        />
        {/* Counted only while searching: "12 of 12" beside an untouched box is noise, but an empty
            result has to be distinguishable from a person with nothing on record. */}
        {query && (
          <span className="muted">{t.persona.matched(shown, total)}</span>
        )}
        <Button asChild variant="outline">
          <Link href={`/entity/?id=${encodeURIComponent(id)}`}>
            {t.common.openAsRecord}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/graph/?scope=${encodeURIComponent(id)}`}>
            {t.common.openInGraph}
          </Link>
        </Button>
        <CopyCode value={t.persona.exportHint(id)} />
      </div>

      {persona.loading ? (
        <Panel>
          <div className="empty">{t.common.loading}</div>
        </Panel>
      ) : (
        <>
          <Panel>
            <PanelHead>
              {t.persona.decisions}
              <span className="muted">{decisions.length}</span>
            </PanelHead>
            <KnowledgeTable
              rows={decisions}
              paginate
              empty={query ? t.persona.noMatch : t.persona.noDecisions}
              trailing={disputedColumn}
            />
          </Panel>
          <Panel>
            <PanelHead>
              {t.persona.otherKnowledge}
              <span className="muted">{facts.length}</span>
            </PanelHead>
            <KnowledgeTable
              rows={facts}
              paginate
              empty={query ? t.persona.noMatch : t.common.none}
              trailing={disputedColumn}
            />
          </Panel>
        </>
      )}
    </>
  );
}

function PersonaBody() {
  const id = useSearchParams().get("id") ?? "";
  return id ? <Person id={id} /> : <Roster />;
}

/** useSearchParams must sit under a Suspense boundary or the static export build fails. */
export default function Persona() {
  const t = useT();
  return (
    <Suspense fallback={<p className="muted">{t.common.loading}</p>}>
      <PersonaBody />
    </Suspense>
  );
}
