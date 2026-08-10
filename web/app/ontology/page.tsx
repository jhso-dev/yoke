"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DirectionIcon } from "../../components/DirectionIcon";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Modal } from "../../components/Modal";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel, PanelHead } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { announce } from "../../lib/toast";
import type { TypeDef } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** The schema, as data. Type defs are not versioned knowledge, so this is the one screen without
 * citations — and it says so rather than leaving the absence unexplained. */
export default function Ontology() {
  const t = useT();
  const defs = useAsync(() => api.ontology(), []);
  const rows = defs.data ?? [];
  const entities = rows.filter((d) => d.kind === "entity");
  const relations = rows.filter((d) => d.kind === "relation");

  return (
    <>
      <div className="page-head">
        <h1>{t.ontology.heading}</h1>
        <AddTypeButton onSaved={defs.reload} />
      </div>
      <p className="lede">{t.ontology.lede}</p>
      <ErrorBanner error={defs.error} onRetry={defs.reload} />
      {defs.loading ? (
        <Panel>
          <div className="empty">{t.common.loading}</div>
        </Panel>
      ) : (
        <>
          <TypeTable title={t.ontology.entityTypes} list={entities} />
          <TypeTable title={t.ontology.relationTypes} list={relations} />
          <Maintenance types={rows} onDone={defs.reload} />
        </>
      )}
    </>
  );
}

function TypeTable({ title, list }: { title: string; list: TypeDef[] }) {
  const t = useT();
  const page = usePage(list);
  return (
    <Panel>
      <PanelHead>
        {title}
        <span className="muted">{list.length}</span>
      </PanelHead>
      {list.length === 0 ? (
        <div className="empty">{t.common.none}</div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.ontology.name}</TableHead>
                <TableHead>{t.common.attributes}</TableHead>
                <TableHead>{t.ontology.freshness}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((d) => (
                <TableRow key={`${d.kind}:${d.name}`}>
                  <TableCell className="mono">{d.name}</TableCell>
                  <TableCell className="mono">
                    {Object.entries(d.attrs)
                      .map(([k, s]) => (s.required ? `${k}*` : k))
                      .join(", ") || "—"}
                  </TableCell>
                  <TableCell className="num">
                    {d.ttl_days === undefined ? (
                      <span title={t.ontology.neverStale}>∞</span>
                    ) : (
                      t.ontology.days(d.ttl_days)
                    )}
                  </TableCell>
                  <TableCell>
                    <Link href={`/browse/?type=${encodeURIComponent(d.name)}`}>
                      {t.common.browse}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            page={page.page}
            pages={page.pages}
            setPage={page.setPage}
            total={list.length}
          />
        </>
      )}
    </Panel>
  );
}

/** The title-row action: a button, and the declare form in a modal behind it. */
function AddTypeButton({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t.ontology.declare}
      </Button>
      <Modal
        open={open}
        title={t.ontology.declare}
        description={t.ontology.declareNote}
        onClose={() => setOpen(false)}
        holdsForm
      >
        {/* Saving closes and says the name, like every other create dialog here. It used to clear
            the fields and sit open, so the one screen where the change lands in a table BEHIND the
            modal was also the one that gave no sign anything had happened. */}
        <AddType
          onSaved={(name) => {
            announce(t.ontology.typeSaved(name));
            setOpen(false);
            onSaved();
          }}
        />
      </Modal>
    </>
  );
}

/** `yoke ontology add-type`. Append-only per name, so declaring an existing name is a migration. */
function AddType({ onSaved }: { onSaved: (name: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"entity" | "relation">("entity");
  // `k` or `k*` — the same shorthand the table above prints, so what you read is what you type.
  const [attrs, setAttrs] = useState("");
  const [ttl, setTtl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  return (
    <form
      className="grid gap-4"
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
          // A freshness window is only sent when it is a real one. `Number("30 days")` is NaN,
          // which JSON.stringify writes as `null`, which nothing rejects and the table then
          // renders as "null days" — a type whose freshness rule is a typo.
          const days = Number(ttl.trim());
          const saved = await api.addType({
            name: name.trim(),
            kind,
            attrs: parsed,
            ...(ttl.trim() && Number.isFinite(days) && days > 0
              ? { ttl_days: days }
              : {}),
          });
          setName("");
          setAttrs("");
          setTtl("");
          onSaved(saved.name);
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="type-name">{t.ontology.name}</Label>
          <Input
            id="type-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-kind">{t.ontology.kind}</Label>
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as "entity" | "relation")}
          >
            <SelectTrigger id="type-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="entity">{t.ontology.entity}</SelectItem>
              <SelectItem value="relation">{t.ontology.relation}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-attrs">
            {t.common.attributes}{" "}
            <span className="text-muted-foreground font-normal">
              {t.ontology.attrsHint}
            </span>
          </Label>
          <Input
            id="type-attrs"
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
            placeholder={t.ontology.attrsExample}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-ttl">
            {t.ontology.freshness}{" "}
            <span className="text-muted-foreground font-normal">
              {t.ontology.ttlHint}
            </span>
          </Label>
          <Input
            id="type-ttl"
            type="number"
            min={1}
            step={1}
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? t.common.saving : t.ontology.saveType}
          </Button>
        </div>
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
  types,
  onDone,
}: {
  types: TypeDef[];
  onDone: () => void;
}) {
  const t = useT();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The outcome is ANNOUNCED, never held in this component's state: `onDone()` reloads the
  // ontology, the parent swaps in its loading branch, and this panel unmounts — which is how
  // "scanned 412 records, added 7 edges" and "renamed X to Y — 42 rows rewritten" were computed,
  // translated, and then thrown away. Two whole-namespace repairs with no feedback at all.
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      announce(await fn());
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // Grouped by kind, and keyed by kind:name. A flat list of every type gave no clue whether you
  // were renaming an entity or a relation, and two kinds sharing a name produced two options with
  // the same value — Radix picks one and the target of the rename became a coin toss.
  const groups = (["entity", "relation"] as const)
    .map((kind) => ({ kind, list: types.filter((d) => d.kind === kind) }))
    .filter((g) => g.list.length > 0);

  return (
    <Panel>
      <PanelHead>
        {t.ontology.maintenance}
        <span className="muted">{t.ontology.maintenanceNote}</span>
      </PanelHead>
      <div className="controls">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          title={t.ontology.backfillHint}
          onClick={() =>
            run(async () => {
              const r = await api.backfill();
              return t.ontology.backfillDone(r.scanned, r.created);
            })
          }
        >
          {t.ontology.backfill}
        </Button>
      </div>
      <div className="controls">
        <Select value={from} onValueChange={setFrom}>
          <SelectTrigger aria-label={t.ontology.renameFrom} className="w-56">
            <SelectValue placeholder={t.ontology.renamePlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.kind}>
                <SelectLabel>
                  {g.kind === "entity"
                    ? t.ontology.entity
                    : t.ontology.relation}
                </SelectLabel>
                {g.list.map((d) => (
                  <SelectItem key={`${d.kind}:${d.name}`} value={d.name}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <DirectionIcon direction="right" />
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={t.ontology.newName}
          aria-label={t.ontology.renameTo}
          className="w-56"
        />
        {/* Not destructive: a rename is reversible by running it back (see this panel's note), and
            red here devalues the red on Deprecate, which is the one act that retires knowledge. */}
        <Button
          type="button"
          disabled={busy || !from || !to.trim() || from === to.trim()}
          title={t.ontology.renameHint}
          onClick={() =>
            run(async () => {
              const r = await api.renameType({ from, to: to.trim() });
              setFrom("");
              setTo("");
              return t.ontology.renameDone(r.from, r.to, r.rows);
            })
          }
        >
          {t.ontology.rename}
        </Button>
      </div>
      <ErrorBanner error={error} />
    </Panel>
  );
}
