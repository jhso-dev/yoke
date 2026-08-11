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
import { announce } from "../lib/toast";
import type { Knowledge, TypeDef } from "../lib/types";
import { DirectionIcon } from "./DirectionIcon";
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
 *
 * Two things this control deliberately refuses to guess:
 *
 * The relation type has NO default. It used to default to the first declared relation, which in the
 * seed is `authored_by` — so pasting an id and pressing Link recorded "this record was written by
 * that one". Recording a relation is a claim, and the one thing a picker must not do is pick for
 * you.
 *
 * And `authored_by` is not offered at all. The gate creates it from `provenance.actor` on every
 * commit, so a hand-made one is almost always a mistake — and it is the edge a persona walks, so a
 * wrong one puts records into someone's judgment that they never wrote. `yoke link X authored_by Y`
 * stays available for the deliberate case (and `yoke backfill` for the bulk one), which is the
 * pattern this product uses everywhere: the screen offers what a reader should reach for, the CLI
 * keeps what an operator sometimes needs.
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
  const relations = ontology.filter(
    (d) => d.kind === "relation" && d.name !== "authored_by",
  );
  const [type, setType] = useState("");
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
      // A relation's identity is (type, from, to), so linking the same pair again stores nothing.
      // Saying so beats a silent success that looks identical to having added something.
      const { existed } = await api.link({
        from: outgoing ? record.id : id,
        type,
        to: outgoing ? id : record.id,
      });
      announce(existed ? tr.entity.alreadyLinked : tr.entity.linked);
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
        <DirectionIcon direction={outgoing ? "right" : "left"} />
      </Button>
      <Select value={type} onValueChange={setType}>
        <SelectTrigger aria-label={tr.common.relation} className="w-48">
          <SelectValue placeholder={tr.entity.pickRelation} />
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
