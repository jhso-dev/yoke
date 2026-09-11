// The zero-action credential for a team server (SPEC "GitHub exchange"). A hook is non-interactive —
// it can never open a browser or ask for a paste — so the only credential it can acquire on its own
// is one exchanged for something the machine already holds: the developer's `gh` login. The cached
// yoke token is what travels afterwards; the GitHub token is spent on the one exchange call.
//
// Same hard rule as every other file here: silence, never a broken session. No gh, no server, a
// refused exchange — each is null, and the caller prints nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cacheDir = (env) => env.YOKE_AUTH_DIR || join(env.HOME || homedir(), ".yoke");
const cacheFile = (server, env) =>
  join(
    cacheDir(env),
    // Keyed by server, not by repo: the token is the CLIENT's credential, and one exchange per
    // machine covers every repo that points at the same server.
    `token-${createHash("sha256").update(server).digest("hex").slice(0, 16)}.json`,
  );

/** Drop the cached token — the 401 path: revoked or rotated server-side, so the next call re-exchanges. */
export function clearToken(server, env) {
  try {
    rmSync(cacheFile(server, env));
  } catch {
    // nothing cached — already the state we want
  }
}

/**
 * A yoke token for `server`: the cache, else one minted by the exchange.
 *
 * `minted` is set only when the exchange just ran — the caller announces it once, because a
 * credential leaving the machine silently is the kind of thing that costs trust when discovered.
 * `YOKE_TOKEN` in env short-circuits everything: an explicitly configured credential is not ours to
 * manage. 0600 on the cache file: it is a bearer secret.
 */
export async function getToken(server, env) {
  if (env.YOKE_TOKEN) return { token: env.YOKE_TOKEN };
  try {
    const c = JSON.parse(readFileSync(cacheFile(server, env), "utf8"));
    if (c?.token) return { token: c.token };
  } catch {
    // no cache — fall through to the exchange
  }
  const gh = spawnSync(env.YOKE_GH_BIN || "gh", ["auth", "token"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const ghToken = gh.status === 0 ? (gh.stdout ?? "").trim() : "";
  if (!ghToken) return null;
  try {
    const res = await fetch(new URL("/api/login/github", server), {
      method: "POST",
      headers: { authorization: `Bearer ${ghToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.token) return null;
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(
      cacheFile(server, env),
      JSON.stringify({ token: body.token, login: body.login, server }),
      { mode: 0o600 },
    );
    return { token: body.token, minted: body.login };
  } catch (e) {
    // The silence rule hides real failures too, so the one escape hatch: YOKE_DEBUG=1 puts the cause
    // on stderr, which the client keeps in its debug log without touching the model's context.
    if (process.env.YOKE_DEBUG) process.stderr.write(`yoke auth: ${e}\n`);
    return null;
  }
}
