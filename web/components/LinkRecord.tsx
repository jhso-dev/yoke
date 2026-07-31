"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { recordLabel } from "../lib/citation";
import type { Knowledge, TypeDef } from "../lib/types";
import { ErrorBanner } from "./ErrorBanner";

/**
 * `yoke link` for one record: pick a relation type, a direction, and the other end.
 *
 * Direction is a control rather than an assumption because a general link cannot assume one — the
 * collaboration screen fixes it (works_on only ever points person → collaboration) precisely because
 * it knows which relation it is recording. Here the caller does not, so the arrow is shown and
 * chosen: `supersedes` recorded backwards silently reverses which record the ontology considers
 * current.
 *
 * The other end is typed, not picked from a list: a namespace can hold more records than a select
 * should ever contain, and pasting an id is what the graph and every table already hand you. The
 * gate rejects an id that does not resolve, so there is nothing to validate here.
 */
export function LinkRecord({
  ontology,
  record,
  onLinked,
}: {
  ontology: TypeDef[];
  record: Knowledge;
  onLinked: () => void;
}) {
  const relations = ontology.filter((t) => t.kind === "relation");
  const [type, setType] = useState(relations[0]?.name ?? "");
  const [outgoing, setOutgoing] = useState(true);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = other.trim();
      await api.link({
        from: outgoing ? record.id : id,
        type,
        to: outgoing ? id : record.id,
      });
      setOther("");
      onLinked();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (relations.length === 0) return null;
  return (
    <form onSubmit={submit} className="controls">
      <span className="muted">{recordLabel(record)}</span>
      <button
        type="button"
        onClick={() => setOutgoing((v) => !v)}
        title="swap which end this record is"
        aria-label={outgoing ? "points at the other record" : "is pointed at"}
      >
        {outgoing ? "→" : "←"}
      </button>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        aria-label="relation"
      >
        {relations.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
          </option>
        ))}
      </select>
      <input
        value={other}
        onChange={(e) => setOther(e.target.value)}
        placeholder="other record id"
        aria-label="other record id"
        style={{ minWidth: 260 }}
      />
      <button type="submit" disabled={busy || !other.trim() || !type}>
        {busy ? "linking…" : "link"}
      </button>
      <ErrorBanner error={error} />
    </form>
  );
}
