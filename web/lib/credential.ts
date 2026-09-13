// Where the Bearer credential lives.
//
// sessionStorage with an in-memory mirror. The alternatives and why not:
//   - memory only: forces a re-paste on every reload and breaks deep links, which is fatal for a
//     tool whose job is "here is the link to that record".
//   - localStorage: survives closing the tab, so a shared machine keeps the credential.
//
// The XSS trade is accepted under mitigations that are cheap and enforced: React escapes by
// default, nothing in web/ uses dangerouslySetInnerHTML, no user-supplied value is ever rendered
// into an href/src, and the credential is least-privilege (`yoke token create --scopes read`).
// It is NOT revocable — a signed credential stands until it expires (front/serve/credential.ts).
//
// The refresh token is the exception to sessionStorage, and deliberately: it is what stops an expired
// access token from sending someone to a login form with nothing to paste, and in sessionStorage it
// would die with the tab and buy nothing. The cost is real and stated — a year-long credential on
// disk, so a shared browser keeps one until someone signs out or the key is rotated.
//
// There is no cookie anywhere, which is why the API needs no CSRF machinery.

const KEY = "yoke.cred";
const REFRESH_KEY = "yoke.refresh";

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
    window.localStorage.removeItem(REFRESH_KEY);
  } catch {
    // nothing to clean up
  }
}

/** The refresh token, which outlives the tab so a week-old session still opens without a re-paste. */
export function getRefresh(): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setRefresh(value: string): void {
  try {
    window.localStorage.setItem(REFRESH_KEY, value);
  } catch {
    // A session that cannot persist its refresh token still works; it just asks again later.
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
