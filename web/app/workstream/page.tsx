"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { KnowledgeTable } from "../../components/KnowledgeTable";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel } from "../../lib/citation";
import { isMissing } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * The shared working context, made visible.
 *
 * v4.0 made a workstream anchor a first-class thing in core, MCP and the CLI, and the web tier shipped
 * without it — the only trace was a placeholder in the inject box, so a workstream id was something you
 * had to already know. This screen is the missing half: pick the work, see who is on it, and see the
 * briefing an agent actually receives when it anchors there.
 *
 * It adds no endpoint. A workstream is an entity, its members are relations, and its briefing is
 * `inject(scope)` — so this composes three routes that already exist, which is also why every action
 * here stays CLI-achievable (`yoke list --type workstream`, `yoke get --relations`, `yoke inject
 * --scope`).
 */
function WorkstreamBody() {
  const id = useSearchParams().get("id") ?? "";
  const list = useAsync(
    () => api.entities({ type: "workstream", limit: 200 }),
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

  if (!id) {
    const rows = list.data?.items ?? [];
    return (
      <>
        <h1>Workstreams</h1>
        <p className="lede">
          A unit of collaborative work that groups people and knowledge for its
          duration. Anchoring an injection here is what makes an agent answer
          from <em>this</em> work's context first.
        </p>
        <ErrorBanner error={list.error} />
        <div className="panel">
          {list.loading ? (
            <div className="empty">loading…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              none recorded — create one with{" "}
              <code>yoke add workstream --attr title=… --attr key=…</code>, or
              let an agent do it via <code>yoke_use_scope</code>
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
                          href={`/workstream/?id=${encodeURIComponent(w.id)}`}
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
        <h1>Workstream</h1>
        <ErrorBanner error={detail.error} />
      </>
    );
  if (!d) return <div className="empty">not found in this namespace</div>;

  // works_on points person → workstream, so the members are this record's incoming edges on that type.
  const members = d.relations.in
    .filter((e) => e.type === "works_on")
    .map((e) => e.other);
  // Both directions, and each row keeps its `dir` for the table to render. It is rendered because
  // these edges point INWARD — that is the whole reason a briefing gathers knowledge rather than a
  // workstream holding it, and the panel that shows the edges was the one place not saying so.
  const attached = [...d.relations.in, ...d.relations.out].filter(
    (e) => e.type !== "works_on" && e.type !== "authored_by",
  );

  return (
    <>
      <h1>{recordLabel(d.entity)}</h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        <Link href="/workstream/">all workstreams</Link>
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
        {members.length === 0 ? (
          <div className="empty">
            nobody linked — there is no command that creates a{" "}
            <code>works_on</code> edge yet, so this is empty for every database
            the product built
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

export default function WorkstreamPage() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <WorkstreamBody />
    </Suspense>
  );
}
