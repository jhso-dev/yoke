// yoke's own credentials: signed, never stored.
//
// A stored credential needs a database every instance shares, and that is what stopped `serve` from
// running as more than one process — measured: a token minted on instance A answered 401 on instance
// B, so behind a load balancer authentication was a coin flip per request. A signed credential needs
// only the key, which is configuration rather than state, so any number of instances agree and a
// restart loses nothing.
//
// The trade, stated because it cannot be undone: **nothing can be revoked before it expires.** There
// is no list of live credentials to remove one from. Cutting someone off means rotating
// YOKE_TOKEN_SECRET, which invalidates every credential at once and re-authenticates everybody.
//
// Two lifetimes, because they are exposed differently. The access token travels on every request —
// through proxies, logs and MCP headers — and lasts 7 days. The refresh token travels only to
// /api/refresh and lasts a year, which is what keeps a browser session from ever asking again. A
// caller that knows its credential is disposable asks `mint` for a shorter pair.

import { type JWTPayload, jwtVerify, SignJWT } from "jose";

const ISSUER = "yoke";
const ACCESS_TTL = "7d";
const REFRESH_TTL = "365d";

/** Who a credential speaks for, and what it may do. The whole of what a token carries. */
export interface Credential {
  name: string;
  scopes: string[];
  /** Tenant namespace, or null for the default shared one. */
  ns: string | null;
}

export interface Credentials {
  /** Sent on every request. Short, because it is the one that leaks. */
  token: string;
  /** Sent only to /api/refresh, to mint a new access token without asking the human again. */
  refresh: string;
}

/**
 * The signer, or null when no secret is configured.
 *
 * Null is a refusal rather than a fallback: a default or absent key would mean anyone who read the
 * source could mint an admin credential. `serve --auth` says so and exits; `yoke ui` never gets here.
 */
export function credentialSigner(secret: string | undefined): {
  /** `ttl` (a jose duration, e.g. "1h") shortens BOTH halves. Both, because a credential whose
   *  refresh token outlives it is not short-lived — /api/refresh would mint it back. */
  mint(cred: Credential, ttl?: string): Promise<Credentials>;
  /** The credential this access token carries, or null — expired, wrong signature, or a REFRESH
   *  token presented as an access one, which is the substitution the `typ` claim exists to refuse. */
  verifyAccess(token: string): Promise<Credential | null>;
  verifyRefresh(token: string): Promise<Credential | null>;
} | null {
  if (!secret) return null;
  const key = new TextEncoder().encode(secret);

  const sign = (cred: Credential, typ: "access" | "refresh", ttl: string) =>
    new SignJWT({ scopes: cred.scopes, ns: cred.ns, typ })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setSubject(cred.name)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(key);

  const read = async (
    token: string,
    want: "access" | "refresh",
  ): Promise<Credential | null> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        issuer: ISSUER,
        algorithms: ["HS256"],
      }));
    } catch {
      return null; // expired, tampered, or not one of ours
    }
    if (payload.typ !== want) return null;
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((s): s is string => typeof s === "string")
      : [];
    if (!payload.sub || scopes.length === 0) return null;
    return {
      name: payload.sub,
      scopes,
      ns: typeof payload.ns === "string" ? payload.ns : null,
    };
  };

  return {
    async mint(cred, ttl) {
      const [token, refresh] = await Promise.all([
        sign(cred, "access", ttl ?? ACCESS_TTL),
        sign(cred, "refresh", ttl ?? REFRESH_TTL),
      ]);
      return { token, refresh };
    },
    verifyAccess: (t) => read(t, "access"),
    verifyRefresh: (t) => read(t, "refresh"),
  };
}
