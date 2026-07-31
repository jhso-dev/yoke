"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { recordLabel } from "../lib/citation";
import type { Knowledge, TypeDef } from "../lib/types";
import { ErrorBanner } from "./ErrorBanner";

/**
 * Create a record, from the ontology rather than from hand-written fields per type.
 *
 * Allowed since the 2026-07-31 WEB-UI amendment. The form asserts nothing the gate does not: it
 * marks the ontology's `required` attributes and stops there, because duplicating validation in the
 * client is how a client and a server come to disagree about what is valid. A rejection comes back
 * as the gate's own words and is shown as such.
 *
 * The record enters as a draft with `origin: "web"`, so a reviewer can tell what was typed at a
 * screen from what an agent or a connector captured. That labelling is what the amendment traded the
 * old outright ban for — see WEB-UI.md.
 */
export function CreateRecord({
  ontology,
  type,
  scope,
  onCreated,
}: {
  ontology: TypeDef[];
  /** Fixed type (the collaboration screen creates collaborations), or undefined to let one be picked. */
  type?: string;
  /** Attach the new record to this entity via relates_to — the same second commit `--scope` makes. */
  scope?: string;
  onCreated: (created: Knowledge) => void;
}) {
  const entityTypes = ontology.filter((t) => t.kind === "entity");
  const [chosen, setChosen] = useState(type ?? entityTypes[0]?.name ?? "");
  const active = type ?? chosen;
  const def = ontology.find((t) => t.name === active);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [duplicates, setDuplicates] = useState<Knowledge[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Empty fields are omitted, not sent as "". An optional attribute left blank should be absent
      // from the record, not present and empty — those read differently in a briefing.
      const attributes = Object.fromEntries(
        Object.entries(values).filter(([, v]) => v.trim() !== ""),
      );
      const created = await api.create({ type: active, attributes, scope });
      setDuplicates(created.duplicates ?? []);
      setValues({});
      onCreated(created);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const attrs = Object.entries(def?.attrs ?? {});
  return (
    <form onSubmit={submit}>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        Enters as a draft and needs a verify, exactly like one an agent commits.
      </p>
      <div className="stack">
        {!type && (
          <label className="field">
            <span>type</span>
            <select
              value={chosen}
              onChange={(e) => {
                setChosen(e.target.value);
                // Attributes belong to a type; carrying them across a type change would submit fields
                // the new type never declared.
                setValues({});
              }}
              aria-label="type"
            >
              {entityTypes.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {attrs.length === 0 && (
          <span className="muted">
            this type declares no attributes — it will be created with none
          </span>
        )}
        {attrs.map(([name, spec]) => (
          <label key={name} className="field">
            <span>
              {name}
              {spec.required && (
                <span className="muted" title="required by the ontology">
                  {" "}
                  *
                </span>
              )}
            </span>
            <input
              value={values[name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [name]: e.target.value }))
              }
              aria-label={name}
            />
          </label>
        ))}
      </div>
      <div className="controls" style={{ margin: "14px 0 0" }}>
        <button type="submit" className="primary" disabled={busy || !active}>
          {busy ? "creating…" : "create"}
        </button>
      </div>
      <ErrorBanner error={error} />
      {duplicates.length > 0 && (
        // The gate found these; a form that discarded them would help someone create the very thing
        // it warned about. Shown after the fact because the record is already staged as a draft —
        // the reviewer decides, which is the whole shape of this product.
        <div className="banner" data-kind="warn">
          created, but {duplicates.length} similar record
          {duplicates.length > 1 ? "s" : ""} already exist:{" "}
          {duplicates.map((d) => recordLabel(d)).join(" · ")}
        </div>
      )}
    </form>
  );
}
