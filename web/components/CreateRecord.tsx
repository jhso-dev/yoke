"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { recordLabel } from "../lib/citation";
import { useT } from "../lib/i18n";
import type { Knowledge, TypeDef } from "../lib/types";
import { ErrorBanner } from "./ErrorBanner";

/**
 * Create a record, from the ontology rather than from hand-written fields per type.
 *
 * Allowed since the 2026-07-31 WEB-UI amendment. The form asserts nothing the gate does not: it
 * passes the ontology's own `required` flag to the field and stops there. Duplicating validation in
 * the client is how a client and a server come to disagree about what is valid, so a rejection comes
 * back as the gate's own words and is shown as such.
 *
 * The record enters as a draft with `origin: "web"`, so a reviewer can tell what was typed at a
 * screen from what an agent or a connector captured — the labelling the amendment traded the old
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
  onCreated: (created: Knowledge) => void;
}) {
  const tr = useT();
  const entityTypes = ontology.filter((d) => d.kind === "entity");
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
          </Label>
          <Input
            id={`attr-${name}`}
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
      {duplicates.length > 0 && (
        // The gate found these; a form that discarded them would help someone create the very thing
        // it warned about. Shown after the fact because the record is already staged as a draft —
        // the reviewer decides, which is the whole shape of this product.
        <Alert>
          <AlertDescription>
            {tr.create.duplicates(
              duplicates.length,
              duplicates.map((d) => recordLabel(d)).join(" · "),
            )}
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}
