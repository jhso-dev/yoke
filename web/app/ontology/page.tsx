"use client";

import Link from "next/link";
import { ErrorBanner } from "../../components/ErrorBanner";
import { api } from "../../lib/api";
import { useAsync } from "../../lib/useAsync";

/** The schema, as data. Type defs are not versioned knowledge, so this is the one screen without
 * citations — and it says so rather than leaving the absence unexplained. */
export default function Ontology() {
  const defs = useAsync(() => api.ontology(), []);
  const rows = defs.data ?? [];
  const entities = rows.filter((d) => d.kind === "entity");
  const relations = rows.filter((d) => d.kind === "relation");

  const table = (title: string, list: typeof rows) => (
    <div className="panel">
      <div className="panel-head">
        {title}
        <span className="muted">{list.length}</span>
      </div>
      {list.length === 0 ? (
        <div className="empty">none</div>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>attributes</th>
                <th>freshness (ttl)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={`${d.kind}:${d.name}`}>
                  <td className="mono">{d.name}</td>
                  <td className="mono">
                    {Object.entries(d.attrs)
                      .map(([k, s]) => (s.required ? `${k}*` : k))
                      .join(", ") || "—"}
                  </td>
                  <td className="num">
                    {d.ttl_days === undefined ? (
                      <span title="never goes stale">∞</span>
                    ) : (
                      `${d.ttl_days} days`
                    )}
                  </td>
                  <td>
                    <Link href={`/browse/?type=${encodeURIComponent(d.name)}`}>
                      browse
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <>
      <h1>Ontology</h1>
      <p className="lede">
        The entity and relation types this namespace recognises. A{" "}
        <code>*</code> marks a required attribute; the TTL is how long a
        verified record of that type stays fresh before it is withheld again.
        These are schema records, not knowledge, so they carry no citation.
      </p>
      <ErrorBanner error={defs.error} />
      {defs.loading ? (
        <div className="panel">
          <div className="empty">loading…</div>
        </div>
      ) : (
        <>
          {table("entity types", entities)}
          {table("relation types", relations)}
        </>
      )}
    </>
  );
}
