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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Instant } from "../../components/Instant";
import { Modal } from "../../components/Modal";
import { Pagination, usePage } from "../../components/Pagination";
import { Panel } from "../../components/Panel";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { announce } from "../../lib/toast";
import type { CreatedToken, TokenInfo } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** Radix Select reserves the empty string for "no selection", so an "all types" option cannot BE the
 * empty value it means — it carries this token and the handler maps it back. */
const ANY = "__any";

/** The four actions RBAC actually knows (src/front/serve/rbac.ts). The form offers exactly these —
 * a free-text scope field made the caller memorise the grammar to grant "read". `admin` joined them
 * when it stopped being `verify`'s second job: it grants the credential routes and nothing else. */
const ACTIONS = ["read", "write", "verify", "admin"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * Compose scope strings in rbac.ts's own grammar. The form offers the action and an optional
 * record-type narrowing; the namespace comes from the SERVER, which `/api/meta` already reports.
 *
 * It used to be a hard-coded wildcard, on the argument that a namespace is a multi-tenant concept with
 * no meaningful answer on a local single-user screen. That reasoning holds for the local case and is
 * wrong for the deployed one: a wildcard-namespace scope grants every tenant, so this form silently
 * minted deployment-wide credentials on a per-tenant server — and now that an admin may only grant
 * within its own namespace, they would simply be refused. A wildcard is still what the default
 * namespace needs (`ceiling:` in rbac.ts), which is exactly the `ns === null` case.
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
  const tokens = useAsync(() => api.tokens(), []);
  const rows = [...(tokens.data ?? [])].reverse();
  const page = usePage(rows);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [error, setError] = useState<unknown>(null);

  return (
    <>
      <div className="page-head">
        <h1>{t.tokens.heading}</h1>
        <CreateTokenButton
          ns={ns}
          onCreated={(tok) => {
            setCreated(tok);
            tokens.reload();
          }}
        />
      </div>
      <p className="lede">{t.tokens.lede}</p>
      <ErrorBanner error={tokens.error ?? error} />
      {/* The secret exists on screen exactly once, so it gets a dialog the reader must dismiss —
          a panel below the fold is how a credential scrolls away unsaved. */}
      {created && (
        <SecretModal token={created} onClose={() => setCreated(null)} />
      )}
      {/* No `.scroll-x` around the table: Table renders its own `overflow-x-auto` container, so the
          wrapper was a second scroller around the first — and the pager it also held scrolled
          sideways out of view on a narrow viewport, which is the one control a reader needs to reach
          page 2. The pager now sits outside the table's container. */}
      <Panel>
        {tokens.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{t.tokens.empty}</div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.tokens.name}</TableHead>
                  <TableHead>{t.tokens.scopes}</TableHead>
                  <TableHead>{t.common.when}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((tok) => (
                  <TokenRow
                    key={tok.name}
                    token={tok}
                    onRevoked={tokens.reload}
                    onError={setError}
                  />
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={page.page}
              pages={page.pages}
              setPage={page.setPage}
              total={rows.length}
            />
          </>
        )}
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
  // The narrowing is chosen from the ontology, like every other type picker in the app. It was free
  // text, and a typo minted a REAL token whose scopes matched no type — the preview below printed
  // `*:desicion:read` without complaint and nothing failed until a caller was refused at runtime.
  const ontology = useAsync(() => api.ontology(), []);

  const scopes = composeScopes(actions, type.trim(), ns);
  const hints: Record<Action, string> = {
    read: t.tokens.readHint,
    write: t.tokens.writeHint,
    verify: t.tokens.verifyHint,
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

function TokenRow({
  token,
  onRevoked,
  onError,
}: {
  token: TokenInfo;
  onRevoked: () => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const revoke = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.revokeToken(token.name);
      announce(t.tokens.revoked(token.name));
      setConfirming(false);
      onRevoked();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell className="mono">{token.name}</TableCell>
      <TableCell className="mono">{token.scopes.join(", ")}</TableCell>
      <TableCell className="mono">
        <Instant iso={token.created_at} />
      </TableCell>
      <TableCell>
        {/* Destructive, and it now looks it: this was `variant="secondary"` — the same grey box as
            "Previous" in the pager directly below it — one click away from ending a credential. */}
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {busy ? t.common.saving : t.tokens.revoke}
        </Button>
        {/* The rule this project skips a confirmation under is reversibility — rename-type on the
            ontology screen reports the row count afterwards instead of asking first, because you can
            run it back the other way. Revoke is the opposite: yoke stores only the hash, so the secret
            cannot be recovered and the only repair is minting a new token and redistributing it to
            everything that was using this one. That earns a dialog, and the dialog names the token so
            a misread row is caught before the click and not after. */}
        <Modal
          open={confirming}
          title={t.tokens.revokeTitle}
          description={t.tokens.revokeConfirm(token.name)}
          onClose={() => setConfirming(false)}
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={revoke}
            >
              {busy ? t.common.saving : t.tokens.revoke}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t.common.close}
            </Button>
          </div>
        </Modal>
      </TableCell>
    </TableRow>
  );
}
