"use client";

import Link from "next/link";
import { useState } from "react";
import { Actor } from "../../components/Actor";
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { Pagination, usePage } from "../../components/Pagination";
import { api } from "../../lib/api";
import { recordLabel, shortId } from "../../lib/citation";
import { useT } from "../../lib/i18n";
import { isoFromLocalInput } from "../../lib/time";
import type { AuditEntry } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/**
 * Who was told what, when — answerable without shell access.
 *
 * The action names are shown as-is and never collapsed: `inject` is what an agent received,
 * `inject_preview` is a human looking at this workbench, `persona` is a person-anchored read,
 * `verify`/`deprecate` are governance acts. The readable gloss for each lives in the dictionary
 * (`t.audit.meaning`) — the NAME is the audit fact and is not translated; the explanation is.
 */

/** A bulk verify names every id it promoted, which can be thousands. Render a readable prefix and
 * say how many were left off — the count is the honesty, the full list is in `yoke audit`. */
const SHOW_REFS = 12;

function Detail({ event }: { event: AuditEntry }) {
  const t = useT();
  // Two shapes: `<subject> -> <id> …` for a read, a bare id list for verify/deprecate. Returning the
  // raw text when there is no arrow is what made a verify row a column of ULIDs.
  const [head, right] = event.detail.split(" -> ");
  // With an arrow the head is the query or person that was read; without one the whole string is the
  // id list, and printing it as a subject would put the ULIDs back beside their resolved form.
  const subject = right === undefined ? "" : head;
  const all = (right ?? head ?? "").split(" ").filter(Boolean);
  if (all.length === 0) return <span className="muted">{t.audit.nothing}</span>;
  const ids = all.slice(0, SHOW_REFS);
  const more = all.length - ids.length;
  const byId = new Map((event.refs ?? []).map((r) => [r.id, r]));
  const subjectRef = byId.get(subject);
  return (
    <>
      {subject && (
        <>
          {/* A persona row's subject is a person id, and the server resolves it into refs — render
              the name when it is there rather than the ULID it was stored as. */}
          <span>{subjectRef ? recordLabel(subjectRef) : subject}</span>
          <span className="muted"> → </span>
        </>
      )}
      {ids.map((id, i) => {
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
      })}
      {/* Never a silent truncation: the row says how many it left off. */}
      {more > 0 && <span className="muted"> · {t.audit.more(more)}</span>}
    </>
  );
}

export default function Audit() {
  const t = useT();
  // The control's own vocabulary — local wall time, no zone, no seconds. Round-tripping an ISO string
  // through `value` is what made the field clear itself on every pick; the conversion happens once, at
  // the request, and `since` stays the only thing `<input type="datetime-local">` will accept.
  const [since, setSince] = useState("");
  const sinceIso = isoFromLocalInput(since);
  const [action, setAction] = useState("");
  // "Filterable by actor, action and time" is what ROADMAP claims this screen does; actor was
  // missing. It is the axis that answers the question the trail exists for — which agent received
  // what, and which person changed the trust state — and with one actor per local run its absence
  // was invisible.
  const [actor, setActor] = useState("");
  const trail = useAsync(
    () => api.audit({ since: sinceIso || undefined, limit: 500 }),
    [sinceIso],
  );

  const loaded = trail.data?.items ?? [];
  const rows = loaded.filter(
    (e) =>
      (!action || e.action === action) &&
      // Match on the id, never the display name: two people can share a name, and the id is what
      // the trail actually recorded.
      (!actor || e.actor === actor),
  );
  const actions = [...new Set(loaded.map((e) => e.action))];
  const actors = [
    ...new Map(
      loaded.map((e) => [e.actor, e.actorName ?? e.actor] as const),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const orderedRows = [...rows].reverse();
  const page = usePage(orderedRows);

  return (
    <>
      <h1>{t.audit.heading}</h1>
      <p className="lede">
        {t.audit.lede}
        <CopyCode value="yoke audit --json" />
        {t.audit.ledeAfter}
      </p>
      <ErrorBanner error={trail.error} />
      <div className="controls">
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {t.audit.since}
          <input
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="since"
            // Every timestamp on this screen reads in the viewer's zone, so the filter takes one too.
            title={t.audit.sinceHint}
          />
        </label>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="action"
        >
          <option value="">{t.audit.allActions}</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          aria-label="actor"
        >
          <option value="">{t.audit.allActors}</option>
          {actors.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted">
          {t.audit.shown(rows.length, loaded.length)}
        </span>
      </div>
      <div className="panel">
        {trail.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{t.audit.empty}</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t.common.when}</th>
                  <th>{t.common.actor}</th>
                  <th>{t.common.action}</th>
                  <th>{t.common.detail}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((e, i) => (
                  // The index is part of the key because audit_log has no primary key: two identical
                  // events in the same second by the same actor are genuinely indistinguishable. The
                  // rule guards against reordering, and this list is append-only and never reordered.
                  // biome-ignore lint/suspicious/noArrayIndexKey: no id exists to key on.
                  <tr key={`${e.at}-${e.actor}-${e.action}-${i}`}>
                    <td className="mono">
                      <Instant iso={e.at} />
                    </td>
                    <td>
                      <Actor actor={e.actor} actorName={e.actorName} />
                    </td>
                    <td
                      className="mono"
                      title={t.audit.meaning[e.action] ?? e.action}
                    >
                      {e.action}
                    </td>
                    <td>
                      <Detail event={e} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={page.page}
              pages={page.pages}
              setPage={page.setPage}
              total={rows.length}
            />
          </div>
        )}
      </div>
    </>
  );
}
