"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Modal } from "../../components/Modal";
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
      <div className="page-head">
        <h1>Ontology</h1>
        <AddTypeButton onSaved={defs.reload} />
      </div>
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
          <Maintenance names={rows.map((d) => d.name)} onDone={defs.reload} />
        </>
      )}
    </>
  );
}

/** The title-row action: a button, and the declare form in a modal behind it. */
function AddTypeButton({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="primary" onClick={() => setOpen(true)}>
        declare a type
      </button>
      <Modal open={open} title="declare a type" onClose={() => setOpen(false)}>
        <AddType onSaved={onSaved} />
      </Modal>
    </>
  );
}

/** `yoke ontology add-type`. Append-only per name, so declaring an existing name is a migration. */
function AddType({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"entity" | "relation">("entity");
  // `k` or `k*` — the same shorthand the table above prints, so what you read is what you type.
  const [attrs, setAttrs] = useState("");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const parsed = Object.fromEntries(
            attrs
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean)
              .map((a) =>
                a.endsWith("*")
                  ? [a.slice(0, -1), { type: "string", required: true }]
                  : [a, { type: "string" }],
              ),
          );
          await api.addType({
            name: name.trim(),
            kind,
            attrs: parsed,
            ...(ttl.trim() ? { ttl_days: Number(ttl) } : {}),
          });
          setName("");
          setAttrs("");
          setTtl("");
          onSaved();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted" style={{ margin: "0 0 12px" }}>
        An existing name saves a new version — the same append-only migration{" "}
        <code>yoke ontology add-type</code> performs.
      </p>
      <div className="stack">
        <label className="field">
          <span>name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="type name"
          />
        </label>
        <label className="field">
          <span>kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "entity" | "relation")}
            aria-label="kind"
          >
            <option value="entity">entity</option>
            <option value="relation">relation</option>
          </select>
        </label>
        <label className="field">
          <span>
            attributes{" "}
            <span className="muted">— comma separated, * = required</span>
          </span>
          <input
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
            placeholder="title*, owner"
            aria-label="attributes"
          />
        </label>
        <label className="field">
          <span>
            freshness{" "}
            <span className="muted">— days, blank = never goes stale</span>
          </span>
          <input
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            aria-label="ttl days"
          />
        </label>
      </div>
      <div className="controls" style={{ margin: "14px 0 0" }}>
        <button
          type="submit"
          className="primary"
          disabled={busy || !name.trim()}
        >
          {busy ? "saving…" : "save type"}
        </button>
      </div>
      <ErrorBanner error={error} />
    </form>
  );
}

/**
 * The two repairs that operate on the whole namespace: `yoke backfill` and `yoke rename-type`.
 *
 * They live on this screen because both are about types and schema rather than about any one
 * record. Rename shows the row count it rewrote instead of asking for confirmation first — it is
 * reversible by running it back the other way, and a count after the fact is more informative than
 * a dialog before it.
 */
function Maintenance({
  names,
  onDone,
}: {
  names: string[];
  onDone: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fn());
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        maintenance
        <span className="muted">
          namespace-wide repairs — the same two commands, same effects
        </span>
      </div>
      <div className="controls">
        <button
          type="button"
          disabled={busy}
          title="re-derive authored_by edges for records committed before the gate made them"
          onClick={() =>
            run(async () => {
              const r = await api.backfill();
              return `scanned ${r.scanned} records, added ${r.created} authorship edges`;
            })
          }
        >
          backfill authorship
        </button>
      </div>
      <div className="controls">
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="rename from"
        >
          <option value="">rename a type…</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="muted">→</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="new name"
          aria-label="rename to"
        />
        <button
          type="button"
          className="danger"
          disabled={busy || !from || !to.trim() || from === to.trim()}
          title="rewrites the declaration and every stored row, history included"
          onClick={() =>
            run(async () => {
              const r = await api.renameType({ from, to: to.trim() });
              setFrom("");
              setTo("");
              return `renamed ${r.from} to ${r.to} — ${r.rows} rows rewritten`;
            })
          }
        >
          rename
        </button>
      </div>
      {result && (
        <div className="banner" data-kind="ok">
          {result}
        </div>
      )}
      <ErrorBanner error={error} />
    </div>
  );
}
