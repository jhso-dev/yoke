// Where the Bearer credential lives.
//
// sessionStorage with an in-memory mirror. The alternatives and why not:
//   - memory only: forces a re-paste on every reload and breaks deep links, which is fatal for a
//     tool whose job is "here is the link to that record".
//   - localStorage: survives closing the tab, so a shared machine keeps the credential.
//
// The XSS trade is accepted under mitigations that are cheap and enforced: React escapes by
// default, nothing in web/ uses dangerouslySetInnerHTML, no user-supplied value is ever rendered
// into an href/src, and the credential itself is least-privilege (`yoke token create --scopes read`)
// and revocable (`yoke token revoke`).
//
// There is no cookie anywhere, which is why the API needs no CSRF machinery.

const KEY = "yoke.cred";

let memory: string | null = null;

/** Static export prerenders these modules in node at build time, so `window` may not exist. */
const store = (): Storage | null =>
  typeof window === "undefined" ? null : window.sessionStorage;

export function getCredential(): string | null {
  if (memory !== null) return memory;
  try {
    memory = store()?.getItem(KEY) ?? null;
  } catch {
    memory = null; // storage disabled (private mode, blocked cookies) — memory still works
  }
  return memory;
}

export function setCredential(value: string): void {
  memory = value;
  try {
    store()?.setItem(KEY, value);
  } catch {
    // Non-persistent session is a degraded but working state, not an error to surface.
  }
}

export function clearCredential(): void {
  memory = null;
  try {
    store()?.removeItem(KEY);
  } catch {
    // nothing to clean up
  }
}

export function takeCredentialFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );
  const token =
    url.searchParams.get("token") ??
    url.searchParams.get("access_token") ??
    hash.get("token") ??
    hash.get("access_token");
  if (!token) return null;

  setCredential(token);
  url.searchParams.delete("token");
  url.searchParams.delete("access_token");
  hash.delete("token");
  hash.delete("access_token");
  const nextHash = hash.toString();
  const next =
    `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}` || "/";
  window.history.replaceState(null, "", next);
  return token;
}
