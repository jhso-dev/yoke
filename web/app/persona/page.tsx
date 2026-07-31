"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
import { recordLabel } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import { useAsync } from "../../lib/useAsync";

/**
 * What one person's recorded judgment would inject.
 *
 * Citation, not impersonation: this lists that person's own records with their sources. It never
 * synthesizes prose in their voice — the AI does that over MCP, from these same records.
 *
 * Nobody types a ULID, so the person is chosen from the people the ontology knows about.
 */
function PersonaBody() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id") ?? "";
  const [query, setQuery] = useState("");

  const people = useAsync(
    () => api.entities({ type: "person", limit: 200 }),
    [],
  );
  const persona = useAsync(
    () => (id ? api.persona(id) : Promise.resolve(null)),
    [id],
  );

  const pick = (next: string) =>
    router.replace(
      next ? `/persona/?id=${encodeURIComponent(next)}` : "/persona/",
    );

  const hit = (s: string) =>
    !query || s.toLowerCase().includes(query.toLowerCase());
  const decisions = (persona.data?.decisions ?? []).filter((d) =>
    hit(d.summary),
  );
  const facts = (persona.data?.facts ?? []).filter((f) => hit(f.summary));

  const t = useT();
  return (
    <>
      <h1>{t.persona.heading}</h1>
      <p className="lede">{t.persona.lede}</p>
      <ErrorBanner error={people.error ?? persona.error} />
      <div className="controls">
        <select
          value={id}
          onChange={(e) => pick(e.target.value)}
          aria-label="person"
        >
          <option value="">{t.persona.choose}</option>
          {(people.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {recordLabel(p)}
            </option>
          ))}
        </select>
        <input
          placeholder={t.persona.filter}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="filter"
          disabled={!id}
        />
        {id && <span className="muted mono">{t.persona.exportHint(id)}</span>}
      </div>

      {!id ? (
        <div className="panel">
          <div className="empty">{t.persona.prompt}</div>
        </div>
      ) : persona.loading ? (
        <div className="panel">
          <div className="empty">{t.common.loading}</div>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              {t.persona.decisions}
              <span className="muted">{decisions.length}</span>
            </div>
            <KnowledgeTable rows={decisions} empty={t.persona.noDecisions} />
          </div>
          <div className="panel">
            <div className="panel-head">
              {t.persona.otherKnowledge}
              <span className="muted">{facts.length}</span>
            </div>
            <KnowledgeTable rows={facts} empty={t.common.none} />
          </div>
        </>
      )}
    </>
  );
}

/** useSearchParams must sit under a Suspense boundary or the static export build fails. */
export default function Persona() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <PersonaBody />
    </Suspense>
  );
}
