"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const tr = useT();
  const relations = ontology.filter((d) => d.kind === "relation");
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
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 p-3">
      <span className="text-muted-foreground text-sm">
        {recordLabel(record)}
      </span>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOutgoing((v) => !v)}
        title={tr.entity.swapDirection}
        aria-label={outgoing ? tr.entity.pointsAt : tr.entity.isPointedAt}
      >
        {outgoing ? "→" : "←"}
      </Button>
      <Select value={type} onValueChange={setType}>
        <SelectTrigger aria-label={tr.common.relation} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {relations.map((r) => (
            <SelectItem key={r.name} value={r.name}>
              {r.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={other}
        onChange={(e) => setOther(e.target.value)}
        placeholder={tr.entity.otherRecordId}
        aria-label={tr.entity.otherRecordId}
        className="w-72"
        required
      />
      <Button type="submit" disabled={busy || !other.trim() || !type}>
        {busy ? tr.common.linking : tr.common.link}
      </Button>
      <ErrorBanner error={error} />
    </form>
  );
}
