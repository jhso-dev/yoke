"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { announce } from "../../lib/toast";
import type { CreatedToken, TokenInfo } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

/** The three actions RBAC actually knows (src/front/serve/rbac.ts). The form offers exactly these —
 * a free-text scope field made the caller memorise the grammar to grant "read". */
const ACTIONS = ["read", "write", "verify"] as const;
type Action = (typeof ACTIONS)[number];

/** Compose scope strings in rbac.ts's own grammar. The form offers the action and an optional
 * record-type narrowing; the grammar's namespace segment stays a wildcard — a namespace is a
 * multi-tenant (`serve --auth`) concept, and asking the local single-user screen to name one was
 * a question with no meaningful answer here. `yoke token create` still spells ns-scoped grants. */
function composeScopes(actions: Set<Action>, type: string): string[] {
  return ACTIONS.filter((a) => actions.has(a)).map((a) =>
    type ? `*:${type}:${a}` : a,
  );
}

export default function Tokens() {
  const t = useT();
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
      <div className="panel">
        {tokens.loading ? (
          <div className="empty">{t.common.loading}</div>
        ) : rows.length === 0 ? (
          <div className="empty">{t.tokens.empty}</div>
        ) : (
          <div className="scroll-x">
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
          </div>
        )}
      </div>
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
}: {
  onCreated: (token: CreatedToken) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [actions, setActions] = useState<Set<Action>>(new Set(["read"]));
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const scopes = composeScopes(actions, type.trim());
  const hints: Record<Action, string> = {
    read: t.tokens.readHint,
    write: t.tokens.writeHint,
    verify: t.tokens.verifyHint,
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
            <Input
              id="token-type"
              className="mono"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder={t.tokens.anyPlaceholder}
            />
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
          <ErrorBanner error={error} />
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
  return (
    <TableRow>
      <TableCell className="mono">{token.name}</TableCell>
      <TableCell className="mono">{token.scopes.join(", ")}</TableCell>
      <TableCell className="mono">
        <Instant iso={token.created_at} />
      </TableCell>
      <TableCell>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              await api.revokeToken(token.name);
              announce(t.tokens.revoked(token.name));
              onRevoked();
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t.common.saving : t.tokens.revoke}
        </Button>
      </TableCell>
    </TableRow>
  );
}
