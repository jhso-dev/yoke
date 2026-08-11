"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { Knowledge, TypeDef } from "../lib/types";
import { ErrorBanner } from "./ErrorBanner";

/** What the gate said about the commit, alongside the record it made. The caller decides how to
 * show it (CreateButton says it as a toast on the way out). */
export type CreateOutcome = Knowledge & {
  duplicates?: Knowledge[];
  duplicateDetection?: "embedding" | "skipped";
};

/**
 * Create a record, from the ontology rather than from hand-written fields per type.
 *
 * Allowed by WEB-UI.md test 3. The form asserts nothing the gate does not: it
 * passes the ontology's own `required` flag to the field and stops there. Duplicating validation in
 * the client is how a client and a server come to disagree about what is valid, so a rejection comes
 * back as the gate's own words and is shown as such.
 *
 * The record enters as a draft with `origin: "web"`, so a reviewer can tell what was typed at a
 * screen from what an agent or a connector captured — the labelling that replaced the old
 * outright ban for.
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
  onCreated: (created: CreateOutcome) => void;
}) {
  const tr = useT();
  const entityTypes = ontology.filter((d) => d.kind === "entity");
  const [chosen, setChosen] = useState(type ?? entityTypes[0]?.name ?? "");
  const active = type ?? chosen;
  const def = ontology.find((t) => t.name === active);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Typed by what the ONTOLOGY declares, not sent as a string whatever the field.
      //
      // Every attribute used to go out as a string, and the gate type-checks them — so
      // `decision.rejected_alternatives`, declared `string[]` in the seed, was rejected the moment
      // anyone typed in it. A decision is the record type this product exists for, and the one field
      // the entity screen calls the most-read in the model could not be filled from the web at all;
      // the only way through the form was to leave it blank.
      //
      // Empty fields are omitted rather than sent as "": an optional attribute left blank should be
      // absent from the record, not present and empty — those read differently in a briefing. A
      // `boolean` is the exception, because `false` is a value someone chose.
      type Value = string | number | boolean | string[];
      const attributes = Object.fromEntries(
        Object.entries(values).flatMap(([k, raw]): [string, Value][] => {
          const kind = def?.attrs[k]?.type ?? "string";
          if (kind === "boolean") return [[k, raw === "true"]];
          if (raw.trim() === "") return [];
          if (kind === "string[]")
            return [
              [
                k,
                raw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ],
            ];
          if (kind === "number") {
            const n = Number(raw);
            // Left to the gate rather than guessed at: sending NaN would arrive as `null` and be
            // stored as one, which is how the ontology screen came to render "null days".
            return Number.isFinite(n) ? [[k, n]] : [];
          }
          return [[k, raw]];
        }),
      );
      const created = await api.create({ type: active, attributes, scope });
      setValues({});
      // The gate's report (duplicates found, or nothing compared) travels WITH the record: the
      // dialog closes on success, so anything rendered here would never be seen.
      onCreated(created);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const attrs = Object.entries(def?.attrs ?? {});
  return (
    <form onSubmit={submit} className="grid gap-4">
      {!type && (
        <div className="grid gap-2">
          <Label htmlFor="create-type">{tr.common.type}</Label>
          <Select
            value={chosen}
            onValueChange={(v) => {
              setChosen(v);
              // Attributes belong to a type; carrying them across a type change would submit fields
              // the new type never declared.
              setValues({});
            }}
          >
            <SelectTrigger id="create-type" className="w-full">
              <SelectValue placeholder={tr.create.pickType} />
            </SelectTrigger>
            <SelectContent>
              {entityTypes.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {attrs.length === 0 && (
        <p className="text-muted-foreground text-sm">{tr.create.noAttrs}</p>
      )}
      {attrs.map(([name, spec], i) => (
        <div key={name} className="grid gap-2">
          <Label htmlFor={`attr-${name}`}>
            {name}
            {spec.required && (
              <span
                className="text-muted-foreground"
                title={tr.common.required}
              >
                *
              </span>
            )}
            {/* The list hint is on the label, not a placeholder: a placeholder disappears the moment
                someone starts typing, which is exactly when the separator matters. */}
            {spec.type === "string[]" && (
              <span className="text-muted-foreground font-normal">
                {tr.create.listHint}
              </span>
            )}
          </Label>
          {spec.type === "boolean" ? (
            <span className="flex items-center gap-1.5">
              <Checkbox
                id={`attr-${name}`}
                checked={values[name] === "true"}
                onCheckedChange={(v) =>
                  setValues((prev) => ({ ...prev, [name]: String(v === true) }))
                }
              />
              <Label
                htmlFor={`attr-${name}`}
                className="text-[inherit] font-[inherit]"
              >
                {tr.create.yes}
              </Label>
            </span>
          ) : (
            <Input
              id={`attr-${name}`}
              type={spec.type === "number" ? "number" : "text"}
              value={values[name] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [name]: e.target.value }))
              }
              // The ontology's own flag handed to the browser. Not a second copy of the rule — the
              // gate still decides — the same rule spending one less round trip to state it, at the
              // field that is wrong rather than in a banner underneath.
              required={spec.required}
              // Focus the first field when the modal opens — <DialogContent> otherwise focuses its
              // own close button, which is a step backwards for someone who came here to type.
              autoFocus={i === 0}
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || !active}>
          {busy ? tr.common.creating : tr.common.create}
        </Button>
        <span className="text-muted-foreground text-xs">
          {tr.common.draftNotice}
        </span>
      </div>
      <ErrorBanner error={error} />
    </form>
  );
}
