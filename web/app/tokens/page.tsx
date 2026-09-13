"use client";

import { useEffect, useState } from "react";
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
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Modal } from "../../components/Modal";
import { Panel } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { CreatedToken } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** Radix Select reserves the empty string for "no selection", so an "all types" option cannot BE the
 * empty value it means — it carries this token and the handler maps it back. */
const ANY = "__any";

/** The three actions RBAC actually knows (src/front/serve/rbac.ts). The form offers exactly these —
 * a free-text scope field would make the caller memorise the grammar to grant "read". `admin` is the
 * operating permission: credentials and ontology changes, and nothing else. */
const ACTIONS = ["read", "write", "admin"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Compose scope strings in rbac.ts's own grammar. The form offers the action and an optional
 * record-type narrowing; the namespace comes from the SERVER, which `/api/meta` already reports.
 *
 * Not a hard-coded wildcard: a wildcard-namespace scope grants every tenant, so on a per-tenant
 * server this form would mint deployment-wide credentials — and an admin may only grant within its
 * own namespace, so the server refuses them anyway. A wildcard is what the default namespace needs
 * (`ceiling:` in rbac.ts), which is exactly the `ns === null` case.
 */
function composeScopes(
  actions: Set<Action>,
  type: string,
  ns: string | null,
): string[] {
  const prefix = ns ?? "*";
  return ACTIONS.filter((a) => actions.has(a)).map((a) =>
    ns === null && !type ? a : `${prefix}:${type || "*"}:${a}`,
  );
}

export default function Tokens() {
  const t = useT();
  // The namespace this server serves. Ungated, so it resolves whether or not a credential is required.
  const meta = useAsync(() => api.meta(), []);
  const ns = meta.data?.ns ?? null;
  const [created, setCreated] = useState<CreatedToken | null>(null);

  return (
    <>
      <div className="page-head">
        <h1>{t.tokens.heading}</h1>
        <CreateTokenButton ns={ns} onCreated={setCreated} />
      </div>
      <p className="lede">{t.tokens.lede}</p>
      <ErrorBanner error={meta.error} />
      {/* The secret exists on screen exactly once, so it gets a dialog the reader must dismiss —
          a panel below the fold is how a credential scrolls away unsaved. */}
      {created && (
        <SecretModal token={created} onClose={() => setCreated(null)} />
      )}
      {/* There is no listing, because a credential is signed rather than stored: nothing here has a
          copy of what was issued, and nothing can take one back. Saying so is the honest screen — an
          empty table would read as "none have been issued". */}
      <Panel>
        <div className="empty">{t.tokens.statelessNote}</div>
      </Panel>
    </>
  );
}

/**
 * Grant by choosing, not by spelling: the actions are checkboxes with one line each on what they
 * let a caller do, the optional namespace/type fields narrow every checked action, and the mono
 * line at the bottom shows the exact scope strings the token will carry — the preview IS the
 * grammar, so there is nothing to memorise and nothing to mistype.
 */
function CreateTokenButton({
  onCreated,
  ns,
}: {
  onCreated: (token: CreatedToken) => void;
  /** The namespace this server serves, so the scopes the form composes are grantable on it. */
  ns: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [actions, setActions] = useState<Set<Action>>(new Set(["read"]));
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The narrowing is chosen from the ontology, like every other type picker in the app. Free text
  // here lets a typo mint a REAL token whose scopes match no type: the preview below prints
  // `*:desicion:read` without complaint and nothing fails until a caller is refused at runtime.
  const ontology = useAsync(() => api.ontology(), []);

  const scopes = composeScopes(actions, type.trim(), ns);
  const hints: Record<Action, string> = {
    read: t.tokens.readHint,
    write: t.tokens.writeHint,
    admin: t.tokens.adminHint,
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const tok = await api.createToken({ name: name.trim(), scopes });
      setName("");
      setActions(new Set(["read"]));
      setType("");
      setOpen(false);
      onCreated(tok);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        {t.tokens.newToken}
      </Button>
      <Modal
        open={open}
        title={t.tokens.newToken}
        description={t.tokens.createdNote}
        onClose={() => setOpen(false)}
      >
        {/* Wider gap than the record forms: this one is SECTIONS (name, permissions, narrowing,
            the grant preview), and sections need more air between them than fields do. */}
        <form onSubmit={submit} className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="token-name">{t.tokens.name}</Label>
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.tokens.namePlaceholder}
              required
              autoFocus
            />
          </div>
          <fieldset className="grid gap-2 border-0 p-0">
            <legend className="mb-2 text-[13px] font-medium">
              {t.tokens.permissions}
            </legend>
            {ACTIONS.map((a) => (
              /* Label beside the control, never around it — see the inject screen's filter row. */
              <span key={a} className="flex items-baseline gap-1.5">
                <Checkbox
                  id={`token-action-${a}`}
                  className="self-center"
                  checked={actions.has(a)}
                  onCheckedChange={(v) =>
                    setActions((prev) => {
                      const next = new Set(prev);
                      if (v === true) next.add(a);
                      else next.delete(a);
                      return next;
                    })
                  }
                />
                <Label
                  htmlFor={`token-action-${a}`}
                  className="text-[inherit] font-[inherit]"
                >
                  <span className="mono">{a}</span>
                  <span className="text-muted-foreground">— {hints[a]}</span>
                </Label>
              </span>
            ))}
          </fieldset>
          <div className="grid gap-2">
            <Label htmlFor="token-type">
              {t.tokens.recordType}{" "}
              <span className="text-muted-foreground font-normal">
                {t.tokens.restrictLegend}
              </span>
            </Label>
            <Select
              value={type || ANY}
              onValueChange={(v) => setType(v === ANY ? "" : v)}
            >
              {/* `.mono` because a type name is a stored value, the same as it was in the field this
                  replaced. */}
              <SelectTrigger id="token-type" className="mono">
                <SelectValue placeholder={t.tokens.anyPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>{t.tokens.allTypes}</SelectItem>
                {(ontology.data ?? [])
                  .filter((d) => d.kind === "entity")
                  .map((d) => (
                    <SelectItem key={d.name} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-muted-foreground text-xs">
            {t.tokens.grants}{" "}
            <span className="mono text-foreground">
              {scopes.length > 0 ? scopes.join(", ") : "—"}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy || scopes.length === 0}>
              {busy ? t.common.creating : t.tokens.create}
            </Button>
          </div>
          {/* A failed ontology fetch belongs here too: it leaves the type picker with nothing but the
              all-types option, which otherwise looks like a namespace that declares no types. */}
          <ErrorBanner error={error ?? ontology.error} />
        </form>
      </Modal>
    </>
  );
}

function SecretModal({
  token,
  onClose,
}: {
  token: CreatedToken;
  onClose: () => void;
}) {
  const t = useT();
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const share = `${origin}/#token=${encodeURIComponent(token.token)}`;
  return (
    <Modal
      open
      title={t.tokens.created}
      description={t.tokens.createdNote}
      onClose={onClose}
    >
      <div className="token-secret">
        <span className="token-label">{t.tokens.secret}</span>
        <CopyCode value={token.token} />
        <span className="token-label">{t.tokens.shareUrl}</span>
        <CopyCode value={share} />
      </div>
    </Modal>
  );
}
