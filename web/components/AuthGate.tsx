"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, configureApi } from "../lib/api";
import { shortId } from "../lib/citation";
import { clearCredential, getCredential } from "../lib/credential";
import { useT } from "../lib/i18n";
import type { Meta } from "../lib/types";

/**
 * The shell's auth state, and the one place the 401 hook is installed.
 *
 * Static export has no middleware, so gating is client-side by necessity — which is also why the
 * server leaves GET / ungated: the shell has to load before a login form can render. The shell
 * carries no knowledge, so nothing leaks by loading it.
 */
export function AuthGate() {
  const t = useT();
  const router = useRouter();
  const here = usePathname();
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    configureApi({
      onUnauthorized: () => {
        if (!here?.startsWith("/login")) router.replace("/login/");
      },
    });
  }, [router, here]);

  useEffect(() => {
    let alive = true;
    api
      .meta()
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        // Auth on and no credential yet → the only useful screen is the login.
        if (m.auth && !getCredential() && !here?.startsWith("/login"))
          router.replace("/login/");
      })
      .catch(() => {
        // /api/meta is ungated; a failure here means the server is unreachable, not unauthorized.
        if (alive) setMeta(null);
      });
    return () => {
      alive = false;
    };
  }, [router, here]);

  if (!meta)
    return <span className="topbar-right muted">{t.chrome.connecting}</span>;

  return (
    <span className="topbar-right">
      {meta.readOnly && (
        <span title={t.chrome.readOnlyHint}>{t.chrome.readOnly}</span>
      )}
      {meta.ns && <span title={t.chrome.namespaceHint}>ns:{meta.ns}</span>}
      {meta.actor && (
        <span title={t.chrome.authedAs(meta.actor)}>
          {meta.actorName ?? shortId(meta.actor)}
        </span>
      )}
      {meta.auth ? (
        getCredential() ? (
          <Button
            type="button"
            onClick={() => {
              clearCredential();
              router.replace("/login/");
            }}
            title={t.chrome.signOutHint}
          >
            {t.chrome.signOut}
          </Button>
        ) : (
          <Link href="/login/">{t.chrome.signIn}</Link>
        )
      ) : (
        <span title={t.chrome.ungatedHint}>{t.chrome.ungated}</span>
      )}
    </span>
  );
}
