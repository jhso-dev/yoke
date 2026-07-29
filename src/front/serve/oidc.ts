// OIDC verification (PLAN-V2 10.3) — RS256 Bearer JWTs via `jose`. Config from env
// YOKE_OIDC_ISSUER / YOKE_OIDC_AUDIENCE. A verified subject (email > sub) maps to an actor;
// serve auto-provisions a person entity on first sight (see serve/index.ts). We never store
// passwords or run our own IdP (ENTERPRISE.md) — trust is delegated to the issuer's JWKS.

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { normalizeNs } from "../../core/namespace.js";
import { parseScope } from "./rbac.js";

// jose's key-resolver type (createRemoteJWKSet / createLocalJWKSet both satisfy it). Tests inject
// a local JWKS so no network is touched.
type JwksResolver = Parameters<typeof jwtVerify>[1];

export interface OidcConfig {
  issuer: string;
  audience: string;
  /** Injected key resolver. Default: a remote JWKS at `${issuer}/.well-known/jwks.json`. */
  jwks?: JwksResolver;
}

export interface OidcSubject {
  /** Stable identity: email claim if present, else sub. Maps to the actor / person id. */
  subject: string;
  /** Namespace claim (`ns`), normalized. null = all-namespaces (no claim). */
  ns: string | null;
  /** Authorization the token itself carries, as validated yoke scope strings. Empty when the token
   * grants nothing — serve then falls back to read-only, because holding an SSO account is not a
   * governance grant. See claimedScopes. */
  scopes: string[];
}

/** Build config from env, or null when OIDC is not configured. */
export function oidcFromEnv(
  env: Record<string, string | undefined>,
): OidcConfig | null {
  const issuer = env.YOKE_OIDC_ISSUER;
  const audience = env.YOKE_OIDC_AUDIENCE;
  if (!issuer || !audience) return null;
  return { issuer, audience };
}

/**
 * The yoke scopes a token grants. Accepts an OAuth-style space-delimited `scope` string or a
 * `scopes` array, and keeps only entries that parse as yoke scopes (rbac grammar) — so an IdP's
 * standard `openid profile email` contributes nothing rather than being mistaken for a grant.
 * Confined to the token's `ns` claim: an unqualified grant is narrowed to that namespace and one
 * naming a different namespace is dropped, so a claim can never reach another tenant.
 */
function claimedScopes(payload: JWTPayload, ns: string | null): string[] {
  const raw =
    typeof payload.scope === "string"
      ? payload.scope.split(/[\s,]+/).filter(Boolean)
      : Array.isArray(payload.scopes)
        ? payload.scopes.filter((s): s is string => typeof s === "string")
        : [];
  const out: string[] = [];
  for (const entry of raw) {
    const sc = parseScope(entry);
    if (!sc) continue;
    if (ns === null) {
      out.push(entry);
    } else if (sc.ns === null || sc.ns === ns) {
      out.push(
        sc.type ? `${ns}:${sc.type}:${sc.action}` : `${ns}:${sc.action}`,
      );
    }
  }
  return out;
}

/** Returns a verifier that resolves a Bearer JWT to its subject, or null when invalid/expired. */
export function makeOidcVerifier(
  cfg: OidcConfig,
): (token: string) => Promise<OidcSubject | null> {
  const jwks =
    cfg.jwks ??
    createRemoteJWKSet(
      new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
    );
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: ["RS256"],
      });
      const subject =
        (typeof payload.email === "string" && payload.email) || payload.sub;
      if (!subject) return null;
      const claimNs = normalizeNs(
        typeof payload.ns === "string" ? payload.ns : null,
      );
      return {
        subject,
        ns: claimNs,
        scopes: claimedScopes(payload, claimNs),
      };
    } catch {
      return null; // expired, wrong audience/issuer, bad signature — all read as "not authenticated"
    }
  };
}
