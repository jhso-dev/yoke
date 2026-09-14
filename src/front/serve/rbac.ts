// RBAC (ENTERPRISE "RBAC", ENTERPRISE.md) — pure authorization over the three axes:
// namespace × entity-type × action(read|write|admin). Deny by default. `write` is the one knowledge
// permission: committing, re-confirming and retiring are the same trust level, because every entry
// is signed and every retirement is broadcast — the checks live downstream of the act, not in a
// second permission. Broader scopes match narrower requests (a wildcard ns/type covers any specific
// ns/type).
//
// Scope grammar (comma list, one entry per string here): `action` | `ns:action` | `ns:type:action`.
// The last segment is always the action; a missing or `*` ns/type segment is a wildcard.

import { normalizeNs } from "../../core/namespace.js";

/**
 * The three actions. `admin` grants the OPERATING routes — credentials, ontology migration,
 * type rename (the writes that bypass or rewrite what the commit gate enforces) — and nothing else.
 *
 * `admin` is deliberately not a superset: an admin who needs to read knowledge asks for `read` too.
 * The point of the separation is that the person who operates the deployment is not automatically
 * the person who can read every tenant's knowledge.
 *
 * Bootstrap is the local path, per invariant 4: `yoke token create` is ungated and single-user, so the
 * first credential — including the first admin one — is minted by whoever owns the machine.
 */
export type Action = "read" | "write" | "admin";
const ACTIONS: readonly string[] = ["read", "write", "admin"];

interface Scope {
  ns: string | null; // null = wildcard (matches any namespace, incl. the default)
  type: string | null; // null = wildcard
  action: Action;
}

const wild = (s: string): string | null => (s === "" || s === "*" ? null : s);

/** The scope grammar, spelled once: the CLI's usage text and every refusal quote this. */
export const SCOPE_GRAMMAR =
  "action | namespace:action | namespace:type:action";

/**
 * The scopes a credential is being minted with, or why it cannot be.
 *
 * Checked at issue time, because a token whose scopes are nonsense authenticates and then 403s on
 * everything — indistinguishable from a working credential until someone tries to use it. The parser
 * that decides what a scope MEANS is the right thing to ask what one IS, so both the CLI and the HTTP
 * route come through here rather than each asking it their own way.
 */
export function validateScopes(
  raw: string[],
):
  | { ok: true; scopes: string[] }
  | { ok: false; error: string; bad: string[] } {
  const scopes = raw.map((s) => s.trim()).filter(Boolean);
  if (scopes.length === 0)
    return {
      ok: false,
      error: "no scopes: a credential with no scope can do nothing",
      bad: [],
    };
  const bad = scopes.filter((s) => parseScope(s) === null);
  if (bad.length > 0)
    return {
      ok: false,
      error: `not a scope: ${bad.join(", ")} — scope is ${SCOPE_GRAMMAR}`,
      bad,
    };
  return { ok: true, scopes };
}

/** Parse one scope string, or null if malformed / unknown action. */
export function parseScope(raw: string): Scope | null {
  const parts = raw.split(":").map((p) => p.trim());
  const action = parts[parts.length - 1];
  if (!ACTIONS.includes(action)) return null;
  if (parts.length === 1)
    return { ns: null, type: null, action: action as Action };
  if (parts.length === 2)
    return { ns: wild(parts[0]), type: null, action: action as Action };
  if (parts.length === 3)
    return {
      ns: wild(parts[0]),
      type: wild(parts[1]),
      action: action as Action,
    };
  return null;
}

/**
 * Deny-by-default check: does any scope grant (ns, type, action)?
 * - action must match exactly (no read⊇write, no write⊇admin).
 * - a scope's explicit ns must equal the request ns; a wildcard ns matches anything.
 *   ceiling: the default (null) namespace is matched only by a wildcard-ns scope (a bare
 *   `action` or `*:...`). Named-ns scopes target that exact ns string. Upgrade to a `default`
 *   keyword if the default ns ever needs finer-than-wildcard grants.
 * - a scope's explicit type must equal the request type; a type-specific scope never grants an
 *   untyped request (type === undefined), so blanket reads need a type-wildcard scope.
 */
export function allowed(
  scopes: string[],
  ns: string | null | undefined,
  type: string | undefined,
  action: Action,
): boolean {
  const reqNs = normalizeNs(ns);
  return scopes.some((raw) => {
    const sc = parseScope(raw);
    if (!sc || sc.action !== action) return false;
    if (sc.ns !== null && sc.ns !== reqNs) return false;
    if (sc.type !== null && sc.type !== type) return false;
    return true;
  });
}

/**
 * May a holder of `held` issue a credential carrying `wanted`?
 *
 * Holding `admin` is permission to run the credential routes; it is not permission to write any scope
 * string into a token. Without this, a tenant admin mints `["*:read"]` and has crossed every boundary
 * the rest of this file enforces — the escalation just takes two steps instead of one.
 *
 * The rule is reach: a namespace-scoped admin may grant only within that namespace, and only a
 * wildcard-ns admin may grant a wildcard-ns scope. Nothing here is a claim about `action` — an admin
 * may hand out `write` without holding it, which is what delegating access means.
 *
 * Returns the scopes that are out of reach, so the caller can name them. Empty means "all grantable".
 */
export function ungrantable(held: string[], wanted: string[]): string[] {
  const adminNs = held
    .map(parseScope)
    .filter((s): s is Scope => s !== null && s.action === "admin")
    .map((s) => s.ns);
  // A wildcard-ns admin reaches everywhere; there is nothing left to check.
  if (adminNs.includes(null)) return [];
  return wanted.filter((raw) => {
    const sc = parseScope(raw);
    // Unparseable is refused by the caller's own validation, not silently treated as grantable.
    if (!sc) return true;
    // A wildcard-ns scope is the whole deployment, so only a wildcard-ns admin may write one.
    if (sc.ns === null) return true;
    return !adminNs.includes(sc.ns);
  });
}
