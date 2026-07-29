"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { api } from "../../lib/api";
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

  return (
    <>
      <h1>Persona</h1>
      <p className="lede">
        The verified knowledge a person authored — what an agent receives when
        it asks how they would decide. Their records with their sources, never
        text written in their voice.
      </p>
      <ErrorBanner error={people.error ?? persona.error} />
      <div className="controls">
        <select
          value={id}
          onChange={(e) => pick(e.target.value)}
          aria-label="person"
        >
          <option value="">choose a person…</option>
          {(people.data?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.summary || p.id}
            </option>
          ))}
        </select>
        <input
          placeholder="filter their records"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="filter"
          disabled={!id}
        />
        {id && (
          <span className="muted mono">
            export: yoke persona {id} --out ./skills
          </span>
        )}
      </div>

      {!id ? (
        <div className="panel">
          <div className="empty">
            pick a person to see the judgment they have on record
          </div>
        </div>
      ) : persona.loading ? (
        <div className="panel">
          <div className="empty">loading…</div>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              guiding decisions
              <span className="muted">{decisions.length}</span>
            </div>
            <KnowledgeTable
              rows={decisions}
              empty="no decisions on record — the bottleneck for a persona is capture, not query"
            />
          </div>
          <div className="panel">
            <div className="panel-head">
              other knowledge
              <span className="muted">{facts.length}</span>
            </div>
            <KnowledgeTable rows={facts} empty="none" />
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
