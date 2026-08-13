// RBAC (PLAN-V2 10.4, ENTERPRISE.md) — pure authorization over the three axes:
// namespace × entity-type × action(read|write|verify). Deny by default. `write` does NOT imply
// `verify` (verify is the governance permission — the whole point of separating them). Broader
// scopes match narrower requests (a wildcard ns/type covers any specific ns/type).
//
// Scope grammar (comma list, one entry per string here): `action` | `ns:action` | `ns:type:action`.
// The last segment is always the action; a missing or `*` ns/type segment is a wildcard.

import { normalizeNs } from "../../core/namespace.js";

/**
 * The four axes. `admin` grants the credential routes and NOTHING else.
 *
 * It was missing, and `verify` stood in for it: `docs/ENTERPRISE.md` says "we separate admin / write /
 * verify" while the code had no admin axis, so the three `/api/tokens` routes gated on `verify` — which
 * every reviewer holds. Measured: a `teamA:verify` token minted a working `["teamB:read",
 * "teamB:verify", "write"]` credential, listed all thirteen tokens in the database with their scopes,
 * and revoked another tenant's. Verify is the governance permission; issuing credentials is not
 * governance, it is the thing governance is granted BY.
 *
 * `admin` is deliberately not a superset: an admin who needs to read knowledge asks for `read` too.
 * The point of the separation is that the person who hands out credentials is not automatically the
 * person who can read every tenant's knowledge.
 *
 * Bootstrap is the local path, per invariant 4: `yoke token create` is ungated and single-user, so the
 * first credential — including the first admin one — is minted by whoever owns the machine.
 */
export type Action = "read" | "write" | "verify" | "admin";
const ACTIONS: readonly string[] = ["read", "write", "verify", "admin"];

interface Scope {
  ns: string | null; // null = wildcard (matches any namespace, incl. the default)
  type: string | null; // null = wildcard
  action: Action;
}

const wild = (s: string): string | null => (s === "" || s === "*" ? null : s);

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
 * - action must match exactly (no read⊇write, no write⊇verify).
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
 * wildcard-ns admin may grant a wildcard-ns scope. Nothing here is a claim about `action` — an admin may
 * hand out `verify` without holding it, which is what delegating governance means.
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
