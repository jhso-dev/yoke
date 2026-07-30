"use client";

import Link from "next/link";
import { useState } from "react";
import { Actor } from "../../components/Actor";
import { ErrorBanner } from "../../components/ErrorBanner";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import type { AuditEntry } from "../../lib/types";
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

/** A bulk verify names every id it promoted, which can be thousands. Render a readable prefix and
 * say how many were left off — the count is the honesty, the full list is in `yoke audit`. */
const SHOW_REFS = 12;

function Detail({ event }: { event: AuditEntry }) {
  const [subject, right] = event.detail.split(" -> ");
  if (right === undefined) return <span>{event.detail}</span>;
  const all = right.split(" ").filter(Boolean);
  const ids = all.slice(0, SHOW_REFS);
  const more = all.length - ids.length;
  const byId = new Map((event.refs ?? []).map((r) => [r.id, r]));
  return (
    <>
      {subject && <span>{subject}</span>}
      <span className="muted"> → </span>
      {all.length === 0 ? (
        <span className="muted">nothing</span>
      ) : (
        ids.map((id, i) => {
          const ref = byId.get(id);
          return (
            <span key={id}>
              {i > 0 && <span className="muted">, </span>}
              <Link href={`/entity/?id=${encodeURIComponent(id)}`}>
                {ref ? recordLabel(ref) : shortId(id)}
              </Link>
              {ref && <span className="muted mono"> {ref.type}</span>}
            </span>
          );
        })
      )}
      {/* Never a silent truncation: the row says how many it left off. */}
      {more > 0 && <span className="muted"> · {more} more</span>}
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
                  // The index is part of the key because audit_log has no primary key: two identical
                  // events in the same second by the same actor are genuinely indistinguishable. The
                  // rule guards against reordering, and this list is append-only and never reordered.
                  // biome-ignore lint/suspicious/noArrayIndexKey: no id exists to key on.
                  <tr key={`${e.at}-${e.actor}-${e.action}-${i}`}>
                    <td className="mono">{e.at}</td>
                    <td>
                      <Actor actor={e.actor} actorName={e.actorName} />
                    </td>
                    <td className="mono" title={MEANING[e.action] ?? e.action}>
                      {e.action}
                    </td>
                    <td>
                      <Detail event={e} />
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
