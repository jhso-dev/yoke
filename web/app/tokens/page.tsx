"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { Pagination, usePage } from "../../components/Pagination";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { CreatedToken, TokenInfo } from "../../lib/types";
import { useAsync } from "../../lib/useAsync";

export default function Tokens() {
  const t = useT();
  const tokens = useAsync(() => api.tokens(), []);
  const rows = [...(tokens.data ?? [])].reverse();
  const page = usePage(rows);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [error, setError] = useState<unknown>(null);

  return (
    <>
      <h1>{t.tokens.heading}</h1>
      <p className="lede">{t.tokens.lede}</p>
      <ErrorBanner error={tokens.error ?? error} />
      <CreateToken
        onCreated={(tok) => {
          setCreated(tok);
          tokens.reload();
        }}
        onError={setError}
      />
      {created && <CreatedTokenPanel token={created} />}
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

function CreateToken({
  onCreated,
  onError,
}: {
  onCreated: (token: CreatedToken) => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("read");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="panel controls token-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        onError(null);
        try {
          const tok = await api.createToken({
            name: name.trim(),
            scopes: scopes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          setName("");
          onCreated(tok);
        } catch (e) {
          onError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <Label htmlFor="token-name">{t.tokens.name}</Label>
        <Input
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.tokens.namePlaceholder}
          required
        />
      </div>
      <div className="field">
        <Label htmlFor="token-scopes">
          {t.tokens.scopes}{" "}
          <span className="text-muted-foreground font-normal">
            {t.tokens.scopesHint}
          </span>
        </Label>
        <Input
          id="token-scopes"
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? t.common.creating : t.tokens.create}
      </Button>
    </form>
  );
}

function CreatedTokenPanel({ token }: { token: CreatedToken }) {
  const t = useT();
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const share = `${origin}/#token=${encodeURIComponent(token.token)}`;
  return (
    <div className="panel">
      <div className="panel-head">
        {t.tokens.created}
        <span className="muted">{t.tokens.createdNote}</span>
      </div>
      <div className="token-secret">
        <span className="token-label">{t.tokens.secret}</span>
        <CopyCode value={token.token} />
        <span className="token-label">{t.tokens.shareUrl}</span>
        <CopyCode value={share} />
      </div>
    </div>
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
