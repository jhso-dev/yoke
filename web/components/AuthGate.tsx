"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, configureApi } from "../lib/api";
import { shortId } from "../lib/citation";
import { clearCredential, getCredential } from "../lib/credential";
import type { Meta } from "../lib/types";

/**
 * The shell's auth state, and the one place the 401 hook is installed.
 *
 * Static export has no middleware, so gating is client-side by necessity — which is also why the
 * server leaves GET / ungated: the shell has to load before a login form can render. The shell
 * carries no knowledge, so nothing leaks by loading it.
 */
export function AuthGate() {
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

  if (!meta) return <span className="topbar-right muted">connecting…</span>;

  return (
    <span className="topbar-right">
      {meta.readOnly && (
        <span title="read replica: writes go to the primary">read-only</span>
      )}
      {meta.ns && <span title="tenant namespace">ns:{meta.ns}</span>}
      {meta.actor && (
        <span title={`authenticated as ${meta.actor}`}>
          {meta.actorName ?? shortId(meta.actor)}
        </span>
      )}
      {meta.auth ? (
        getCredential() ? (
          <button
            type="button"
            onClick={() => {
              clearCredential();
              router.replace("/login/");
            }}
            title="clears this browser's credential; revoke the token itself with `yoke token revoke`"
          >
            sign out
          </button>
        ) : (
          <Link href="/login/">sign in</Link>
        )
      ) : (
        <span title="local single-user mode — no credential required">
          ungated
        </span>
      )}
    </span>
  );
}
