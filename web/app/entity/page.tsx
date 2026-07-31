"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Actor } from "../../components/Actor";
import { Citation } from "../../components/Citation";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { LinkRecord } from "../../components/LinkRecord";
import { StatusBadge } from "../../components/StatusBadge";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
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
  // The relation types this namespace declares — the link control is built from them, so a tenant
  // with its own relation names gets its own list without a code change.
  const ontology = useAsync(() => api.ontology(), []);

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
        <span className="mono">{d.entity.type}</span>{" "}
        {recordLabel(d.entity) === d.entity.summary
          ? d.entity.summary
          : "(no text attributes)"}
      </h1>
      <p className="lede">
        <StatusBadge status={d.entity.effectiveStatus} />{" "}
        {/* This record's own id, shortened like every other id a person reads. Click to copy the
            whole thing — a ULID is for machines and for pasting into a command, not for reading. */}
        <button
          type="button"
          className="mono muted"
          title={`${d.entity.id}\n\nclick to copy`}
          style={{
            border: "none",
            background: "none",
            padding: 0,
            cursor: "copy",
            font: "inherit",
          }}
          onClick={() => navigator.clipboard?.writeText(d.entity.id)}
        >
          {shortId(d.entity.id)}
        </button>
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
                <td>
                  <Actor
                    actor={d.entity.actor}
                    actorName={d.entity.actorName}
                  />
                </td>
              </tr>
              <tr>
                <th>origin</th>
                <td className="mono">{d.entity.origin}</td>
              </tr>
              <tr>
                <th>occurred at</th>
                <td className="mono">
                  <Instant iso={d.entity.occurred_at} />
                </td>
              </tr>
              <tr>
                <th>last confirmed</th>
                <td className="mono">
                  <Instant iso={d.entity.last_confirmed} />
                </td>
              </tr>
              {/* Compact, like everywhere else. Every field the raw string contains is already a row
                  in this table (id in the header, version, recorded by, occurred at) — its only
                  unique value is being copyable exactly, which the click gives. */}
              <tr>
                <th>citation</th>
                <td>
                  <Citation row={d.entity} />
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
                  <td>
                    <Actor actor={h.actor} actorName={h.actorName} />
                  </td>
                  <td className="mono">
                    <Instant iso={h.occurred_at} />
                  </td>
                  <td>
                    <Citation row={h} />
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
        {/* `yoke link` for this record. Any declared relation, either direction — the general case
            the collaboration screen specialises. */}
        <LinkRecord
          ontology={ontology.data ?? []}
          record={d.entity}
          onLinked={detail.reload}
        />
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
                          <span className="mono">{shortId(e.other.id)}</span> —
                          not in this namespace
                        </span>
                      ) : (
                        <Link
                          href={`/entity/?id=${encodeURIComponent(e.other.id)}`}
                        >
                          {recordLabel(e.other)}
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
