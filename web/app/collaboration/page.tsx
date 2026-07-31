"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { isMissing, type Knowledge } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** Pick a person, record `works_on`. Direction is fixed here rather than offered as a choice. */
function AddMember({
  people,
  already,
  to,
  onLinked,
}: {
  people: Knowledge[];
  already: Set<string>;
  to: string;
  onLinked: () => void;
}) {
  const candidates = people.filter((p) => !already.has(p.id));
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (candidates.length === 0 && people.length > 0)
    return <div className="empty">everyone recorded is already on this</div>;
  return (
    <div className="flex flex-wrap items-center gap-2 p-3">
      <Select value={who} onValueChange={setWho}>
        <SelectTrigger aria-label="person" className="w-64">
          <SelectValue placeholder="add someone…" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {recordLabel(p)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        disabled={!who || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.link({ from: who, type: "works_on", to });
            setWho("");
            onLinked();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "linking…" : "add to this work"}
      </Button>
      <ErrorBanner error={error} />
    </div>
  );
}

/**
 * The shared working context, made visible.
 *
 * v4.0 made a collaboration anchor a first-class thing in core, MCP and the CLI, and the web tier shipped
 * without it — the only trace was a placeholder in the inject box, so a collaboration id was something you
 * had to already know. This screen is the missing half: pick the work, see who is on it, and see the
 * briefing an agent actually receives when it anchors there.
 *
 * It adds no endpoint. A collaboration is an entity, its members are relations, and its briefing is
 * `inject(scope)` — so this composes three routes that already exist, which is also why every action
 * here stays CLI-achievable (`yoke list --type collaboration`, `yoke get --relations`, `yoke inject
 * --scope`).
 */
function CollaborationBody() {
  const id = useSearchParams().get("id") ?? "";
  const list = useAsync(
    () => api.entities({ type: "collaboration", limit: 200 }),
    [],
  );
  const detail = useAsync(
    () => (id ? api.entity(id) : Promise.resolve(null)),
    [id],
  );
  // The real thing, not a mock of it: same filter, same ranking, same citations, same audit row as a
  // `yoke_inject` anchored here. If this disagrees with what an agent sees, this screen is lying.
  const briefing = useAsync(
    () => (id ? api.inject({ scope: id, limit: 50 }) : Promise.resolve(null)),
    [id],
  );
  // The create form is built from the ontology, so a tenant that renamed this type or added an
  // attribute gets the right fields with no code change here.
  const ontology = useAsync(() => api.ontology(), []);
  // Candidate members. `person` is the seeded type for a human; a tenant using another name links
  // through the entity screen instead, which is why this list is a convenience and not the only path.
  const people = useAsync(
    () => api.entities({ type: "person", limit: 200 }),
    [],
  );

  if (!id) {
    const rows = list.data?.items ?? [];
    return (
      <>
        <div className="page-head">
          <h1>Collaborations</h1>
          <CreateButton
            ontology={ontology.data ?? []}
            type="collaboration"
            onCreated={list.reload}
          />
        </div>
        {/* Says what the thing IS in the first clause, because the type name alone never did. And
            "attached to" rather than "in": a collaboration holds nothing — people and records point at
            it, which is what the arrows on the graph screen draw. */}
        <p className="lede">
          One thing being worked on together, and the people and knowledge
          attached to it. Anchoring an injection here is what makes an agent
          answer from <em>this</em> work's context first.
        </p>
        <ErrorBanner error={list.error} />
        <div className="panel">
          {list.loading ? (
            <div className="empty">loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              none yet — create one above, with{" "}
              <code>yoke add collaboration --attr title=…</code>, or let an
              agent do it via <code>yoke_use_scope</code>
            </div>
          ) : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    {/* No key column: the list payload carries `summary`, not attributes, and one
                        request per row to fetch a key would be an N+1 for a label. The key is on the
                        record when you open it. */}
                    <th>title</th>
                    <th>status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link
                          href={`/collaboration/?id=${encodeURIComponent(w.id)}`}
                        >
                          {recordLabel(w)}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={w.effectiveStatus} />
                      </td>
                      <td>
                        <Link
                          href={`/graph/?scope=${encodeURIComponent(w.id)}`}
                        >
                          graph
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  }

  if (detail.loading) return <p className="muted">loading…</p>;
  const d = detail.data;
  if (detail.error)
    return (
      <>
        <h1>Collaboration</h1>
        <ErrorBanner error={detail.error} />
      </>
    );
  if (!d) return <div className="empty">not found in this namespace</div>;

  // works_on points person → collaboration, so the members are this record's incoming edges on that type.
  const members = d.relations.in
    .filter((e) => e.type === "works_on")
    .map((e) => e.other);
  // Both directions, and each row keeps its `dir` for the table to render. It is rendered because
  // these edges point INWARD — that is the whole reason a briefing gathers knowledge rather than a
  // collaboration holding it, and the panel that shows the edges was the one place not saying so.
  const attached = [...d.relations.in, ...d.relations.out].filter(
    (e) => e.type !== "works_on" && e.type !== "authored_by",
  );

  return (
    <>
      <h1>{recordLabel(d.entity)}</h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        <Link href="/collaboration/">all collaborations</Link>
      </p>
      <ErrorBanner error={briefing.error} />

      <div className="controls">
        <Link className="btn" href={`/graph/?scope=${encodeURIComponent(id)}`}>
          open in graph
        </Link>
        <Link className="btn" href={`/entity/?id=${encodeURIComponent(id)}`}>
          open as record
        </Link>
        <code>yoke inject --scope {id}</code>
      </div>

      <div className="panel">
        <div className="panel-head">attributes</div>
        <div className="scroll-x">
          <table>
            <tbody>
              {Object.entries(d.entity.attributes).map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: "22%" }}>{k}</th>
                  <td>{typeof v === "string" ? v : JSON.stringify(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          people on this work
          <span className="muted">
            {members.length} · shown here and deliberately NOT in the briefing —
            a roster is not knowledge about the work
          </span>
        </div>
        {/* The direction is not the caller's choice to get wrong: works_on points person →
            collaboration, so the control always links the picked person TO this record. Reversed, the
            collaboration would land on the person's persona instead. */}
        <AddMember
          people={people.data?.items ?? []}
          already={new Set(members.map((m) => m.id))}
          to={id}
          onLinked={detail.reload}
        />
        {members.length === 0 ? (
          <div className="empty">
            nobody linked yet — pick someone above, or run{" "}
            <code>yoke link &lt;person&gt; works_on {shortId(id)}</code>
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {isMissing(m) ? (
                        <span className="muted">not in this namespace</span>
                      ) : (
                        <Link
                          href={`/persona/?id=${encodeURIComponent(m.id)}`}
                          title="read their recorded judgment"
                        >
                          {recordLabel(m)}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          the briefing an agent receives
          <span className="muted">
            exactly what <code>inject(scope)</code> returns — verified only,
            freshest first, audited as a preview
          </span>
        </div>
        {briefing.loading ? (
          <div className="empty">loading…</div>
        ) : (
          <>
            {/* The cap is honest only if it says where the rest is — the same sentence the agent
                gets from yoke_inject, so the screen and the tool cannot disagree. */}
            {(briefing.data?.omitted ?? 0) > 0 && (
              <div className="banner" data-kind="warn">
                showing {briefing.data?.items.length} of{" "}
                {(briefing.data?.items.length ?? 0) +
                  (briefing.data?.omitted ?? 0)}{" "}
                records on this work, most recently confirmed first. The rest
                are not lost — an agent reaches them by asking a specific
                question, which searches everything with this work's records
                first.
              </div>
            )}
            <KnowledgeTable
              rows={briefing.data?.items ?? []}
              empty="nothing in this work's context yet"
            />
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          attached records
          <span className="muted">
            {attached.length} · <code>←</code> points here: the record carries
            the link, this work does not contain it. Deprecating this work
            leaves every one of them untouched
          </span>
        </div>
        {attached.length === 0 ? (
          <div className="empty">
            none — knowledge attaches here when it is captured with{" "}
            <code>--scope</code>
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>direction</th>
                  <th>relation</th>
                  <th>record</th>
                </tr>
              </thead>
              <tbody>
                {attached.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.dir === "out" ? "→" : "←"}</td>
                    <td className="mono">{e.type}</td>
                    <td>
                      {isMissing(e.other) ? (
                        <span className="muted">not in this namespace</span>
                      ) : (
                        <Link
                          href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
                        >
                          {recordLabel(e.other)}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export default function CollaborationPage() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <CollaborationBody />
    </Suspense>
  );
}
