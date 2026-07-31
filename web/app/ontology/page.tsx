"use client";

import Link from "next/link";
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
      <Button type="button" onClick={() => setOpen(true)}>
        declare a type
      </Button>
      <Modal
        open={open}
        title="declare a type"
        description="An existing name saves a new version — the same append-only migration yoke ontology add-type performs."
        onClose={() => setOpen(false)}
      >
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
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="type-name">name</Label>
          <Input
            id="type-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-kind">kind</Label>
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as "entity" | "relation")}
          >
            <SelectTrigger id="type-kind" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="entity">entity</SelectItem>
              <SelectItem value="relation">relation</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-attrs">
            attributes{" "}
            <span className="text-muted-foreground font-normal">
              — comma separated, * = required
            </span>
          </Label>
          <Input
            id="type-attrs"
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
            placeholder="title*, owner"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="type-ttl">
            freshness{" "}
            <span className="text-muted-foreground font-normal">
              — days, blank = never goes stale
            </span>
          </Label>
          <Input
            id="type-ttl"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "saving…" : "save type"}
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
        <Button
          type="button"
          variant="secondary"
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
        </Button>
      </div>
      <div className="controls">
        <Select value={from} onValueChange={setFrom}>
          <SelectTrigger aria-label="rename from" className="w-56">
            <SelectValue placeholder="rename a type…" />
          </SelectTrigger>
          <SelectContent>
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">→</span>
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="new name"
          aria-label="rename to"
          className="w-56"
        />
        <Button
          type="button"
          variant="destructive"
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
        </Button>
      </div>
      {result && (
        <Alert>
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}
      <ErrorBanner error={error} />
    </div>
  );
}
