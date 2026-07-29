"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { isMissing } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * One record, as stored. Nothing inferred, nothing summarized away.
 *
 * The version history is the point as much as the attributes: yoke never overwrites, so every row
 * here is a belief the system once held, and being able to read them in order is what makes
 * "reconstruct what we believed then" a real claim rather than a design note.
 */
function EntityBody() {
  const id = useSearchParams().get("id") ?? "";
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const detail = useAsync(
    () => (id ? api.entity(id) : Promise.resolve(null)),
    [id],
  );

  async function act(kind: "verify" | "deprecate") {
    setBusy(true);
    setActionError(null);
    try {
      await (kind === "verify" ? api.verify([id]) : api.deprecate([id]));
      detail.reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!id)
    return (
      <div className="panel">
        <div className="empty">
          no id — reach this screen from <Link href="/browse/">browse</Link>
        </div>
      </div>
    );
  if (detail.loading) return <p className="muted">loading…</p>;
  if (detail.error)
    return (
      <>
        <h1>Entity</h1>
        <ErrorBanner error={detail.error} />
      </>
    );
  const d = detail.data;
  if (!d) return <div className="empty">not found in this namespace</div>;

  const edges = [...d.relations.out, ...d.relations.in];
  return (
    <>
      <h1>
        <span className="mono">{d.entity.type}</span> {d.entity.summary}
      </h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        <span className="mono muted">{d.entity.id}</span>
      </p>
      <ErrorBanner error={actionError} />

      <div className="controls">
        <button
          type="button"
          className="primary"
          disabled={busy || d.entity.effectiveStatus === "verified"}
          onClick={() => act("verify")}
          title="promote, or re-confirm a stale record"
        >
          {d.entity.effectiveStatus === "stale" ? "re-confirm" : "verify"}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || d.entity.effectiveStatus === "deprecated"}
          onClick={() => act("deprecate")}
        >
          deprecate
        </button>
        <Link
          className="btn"
          href={`/graph/?scope=${encodeURIComponent(d.entity.id)}`}
        >
          open in graph
        </Link>
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
        <div className="panel-head">provenance</div>
        <div className="scroll-x">
          <table>
            <tbody>
              <tr>
                <th style={{ width: "22%" }}>recorded by</th>
                <td className="mono">{d.entity.actor}</td>
              </tr>
              <tr>
                <th>origin</th>
                <td className="mono">{d.entity.origin}</td>
              </tr>
              <tr>
                <th>occurred at</th>
                <td className="mono">{d.entity.occurred_at}</td>
              </tr>
              <tr>
                <th>last confirmed</th>
                <td className="mono">{d.entity.last_confirmed}</td>
              </tr>
              <tr>
                <th>citation</th>
                <td>
                  <Citation value={d.entity.citation} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          version history
          <span className="muted">{d.history.length}</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>v</th>
                <th>stored status</th>
                <th>actor</th>
                <th>occurred at</th>
                <th>source</th>
              </tr>
            </thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.version}>
                  <td className="num">{h.version}</td>
                  <td>
                    <StatusBadge status={h.status} />
                  </td>
                  <td className="mono">{h.actor}</td>
                  <td className="mono">{h.occurred_at}</td>
                  <td>
                    <Citation value={h.citation} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          relations
          <span className="muted">{edges.length}</span>
        </div>
        {edges.length === 0 ? (
          <div className="empty">none — this record stands alone</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>direction</th>
                  <th>type</th>
                  <th>other end</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.dir === "out" ? "→" : "←"}</td>
                    <td className="mono">{e.type}</td>
                    <td>
                      {isMissing(e.other) ? (
                        <span className="mono muted">
                          {e.other.id} — not in this namespace
                        </span>
                      ) : (
                        <Link
                          href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
                        >
                          {e.other.summary || e.other.id}
                        </Link>
                      )}
                    </td>
                    <td>
                      {isMissing(e.other) ? null : (
                        <StatusBadge status={e.other.effectiveStatus} />
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

export default function EntityPage() {
  return (
    <Suspense fallback={<p className="muted">loading…</p>}>
      <EntityBody />
    </Suspense>
  );
}
