// RBAC (PLAN-V2 10.4, ENTERPRISE.md) — pure authorization over the three axes:
// namespace × entity-type × action(read|write|verify). Deny by default. `write` does NOT imply
// `verify` (verify is the governance permission — the whole point of separating them). Broader
// scopes match narrower requests (a wildcard ns/type covers any specific ns/type).
//
// Scope grammar (comma list, one entry per string here): `action` | `ns:action` | `ns:type:action`.
// The last segment is always the action; a missing or `*` ns/type segment is a wildcard.

import { normalizeNs } from "../../core/namespace.js";

export type Action = "read" | "write" | "verify";
const ACTIONS: readonly string[] = ["read", "write", "verify"];

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
 *   ponytail: the default (null) namespace is matched only by a wildcard-ns scope (a bare
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
