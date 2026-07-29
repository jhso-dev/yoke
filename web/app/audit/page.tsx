"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

/**
 * Who was told what, when — answerable without shell access.
 *
 * The action names matter and are shown as-is: `inject` is what an agent received, `inject_preview`
 * is a human looking at this workbench, `persona` is a person-anchored read, `verify`/`deprecate` are
 * governance acts. Collapsing them would destroy the distinction the audit trail exists to record.
 */
const MEANING: Record<string, string> = {
  inject: "an agent received knowledge",
  inject_preview: "a human previewed what an agent would receive",
  persona: "a person's recorded judgment was read",
  verify: "records were promoted",
  deprecate: "records were retired",
};

/** Detail is `query -> id id id`; the ids are worth linking. */
function Detail({ text }: { text: string }) {
  const [left, right] = text.split(" -> ");
  if (right === undefined) return <span>{text}</span>;
  const ids = right.split(" ").filter(Boolean);
  return (
    <>
      <span>{left}</span>
      <span className="muted"> → </span>
      {ids.length === 0 ? (
        <span className="muted">nothing</span>
      ) : (
        ids.map((id, i) => (
          <span key={id}>
            {i > 0 && " "}
            <Link
              className="mono"
              href={`/entity/?id=${encodeURIComponent(id)}`}
            >
              {id.slice(0, 8)}…
            </Link>
          </span>
        ))
      )}
    </>
  );
}

export default function Audit() {
  const [since, setSince] = useState("");
  const [action, setAction] = useState("");
  const trail = useAsync(
    () => api.audit({ since: since || undefined, limit: 500 }),
    [since],
  );

  const rows = (trail.data?.items ?? []).filter(
    (e) => !action || e.action === action,
  );
  const actions = [...new Set((trail.data?.items ?? []).map((e) => e.action))];

  return (
    <>
      <h1>Audit</h1>
      <p className="lede">
        The append-only trail of knowledge read and governance performed.
        Filtering here narrows the loaded window, not the whole history — use{" "}
        <code>yoke audit --json</code> to walk all of it.
      </p>
      <ErrorBanner error={trail.error} />
      <div className="controls">
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          since
          <input
            type="datetime-local"
            value={since}
            onChange={(e) =>
              setSince(e.target.value ? `${e.target.value}:00Z` : "")
            }
            aria-label="since"
          />
        </label>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="action"
        >
          <option value="">all actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="muted">
          {rows.length} of {trail.data?.items.length ?? 0} loaded
        </span>
      </div>
      <div className="panel">
        {trail.loading ? (
          <div className="empty">loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">no audit events in this window</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>when</th>
                  <th>actor</th>
                  <th>action</th>
                  <th>detail</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((e, i) => (
                  <tr key={`${e.at}-${e.actor}-${i}`}>
                    <td className="mono">{e.at}</td>
                    <td className="mono">{e.actor}</td>
                    <td className="mono" title={MEANING[e.action] ?? e.action}>
                      {e.action}
                    </td>
                    <td>
                      <Detail text={e.detail} />
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
