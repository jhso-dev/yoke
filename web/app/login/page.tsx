"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyCode } from "../../components/CopyCode";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ApiError, api } from "../../lib/api";
import { setCredential } from "../../lib/credential";
import { useT } from "../../lib/i18n";

/**
 * Paste a credential. There is no password anywhere in yoke (ENTERPRISE.md), so this takes something
 * already minted: an API token from `yoke token create`, or an OIDC id_token — serve accepts either
 * as a Bearer.
 *
 * Validation hits a GATED endpoint, not /api/meta, because meta answers without a credential and
 * would accept anything. The three outcomes are told apart deliberately: 401 means the credential is
 * wrong, while 403 means it authenticated but carries no read scope — a write-only agent token, which
 * would otherwise look like a working login onto empty screens.
 */
export default function Login() {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setCredential(value.trim());
    try {
      await api.ontology();
      router.replace("/review/");
    } catch (err) {
      if (err instanceof ApiError && err.forbidden) {
        setError(
          new Error(
            "that credential authenticated but has no read scope — mint one with: yoke token create --scopes read",
          ),
        );
      } else {
        setError(new Error(t.login.rejected));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>{t.login.heading}</h1>
      <p className="lede">{t.login.lede}</p>
      <form onSubmit={submit}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={t.login.token}
          aria-label={t.login.credential}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={busy || !value.trim()}>
          {busy ? t.login.checking : t.login.submit}
        </Button>
      </form>
      <ErrorBanner error={error} />
      <div className="banner" data-kind="info">
        {t.login.noTokenBefore}
        <br />
        <CopyCode value="yoke token create --name alex --scopes read" />
        <br />
        {t.login.addPrefix}
        <CopyCode value="yoke token create --name alex --scopes read,verify" />
        {t.login.noTokenAfter}
      </div>
    </div>
  );
}
