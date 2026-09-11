// Shared by the two hook entrypoints. Node core only — this runs on every tool call of every
// session in a repo that installed the plugin, so its one hard rule is: NEVER break a session.
// No scope bound, no yoke binary on this machine, an unreachable store — each means "print
// nothing, exit 0", not an error a person has to dismiss. The setup skill is where wiring is
// checked out loud; a hook is not the place to complain.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearToken, getToken } from "./auth.mjs";

/** The hook's stdin: one JSON object from the client (cwd, hook_event_name, …). {} on anything
 * unparseable, so a malformed payload degrades to "no scope" rather than a crash in the hot path. */
export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

/**
 * A per-repo setting, or null.
 *
 * Env wins (a shell export, or a client that passes settings env through). The fallback reads the
 * repo's own `.claude/settings.json` — the documented binding (ADOPTION §3): the initiative id (and,
 * on a team deployment, the server URL) lives in the repo, so every session in it is wired with no
 * per-session setup. Read from the file directly rather than trusting inheritance, because whether a
 * hook process receives settings env is the client's business, and this must work from the repo
 * alone. `settings.local.json` first: it is the uncommitted, per-person file, and a person's own
 * value outranks the repo's.
 */
export function resolveSetting(cwd, env, key) {
  if (env[key]) return env[key];
  for (const f of ["settings.local.json", "settings.json"]) {
    try {
      const s = JSON.parse(readFileSync(join(cwd, ".claude", f), "utf8"));
      const v = s?.env?.[key];
      if (typeof v === "string" && v) return v;
    } catch {
      // absent or unparseable settings file — try the next one
    }
  }
  return null;
}

/** The working context this repo is anchored on, or null. */
export function resolveScope(cwd, env) {
  return resolveSetting(cwd, env, "YOKE_SCOPE");
}

/**
 * Run `yoke inject <args>` in the project directory and return its stdout, or null.
 *
 * `YOKE_BIN` overrides the binary for a machine where `yoke` is not on PATH (and for tests). Every
 * failure — ENOENT, non-zero exit, the spawn timeout — is null: which store the CLI opens, and why
 * it could not, are the CLI's own environment contract (YOKE_DB, .env, remote URLs), not something
 * a hook should second-guess. The timeout is inside the client's hooks.json budget on purpose, so
 * the failure mode is "no context this round", never a stalled session.
 */
export function runInject(args, cwd, env) {
  const r = spawnSync(env.YOKE_BIN || "yoke", ["inject", ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 8000,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? "";
}

/**
 * The same read against a team server (`YOKE_SERVER` bound): `GET /api/inject?scope=&unseen=1`,
 * authenticated by the zero-action exchange (auth.mjs). The server's ledger is per token, so this is
 * the deployment where the deliveries live server-side and the CLI's local trail would be blind.
 *
 * A 401 clears the cache and re-exchanges ONCE — a token revoked or rotated server-side heals on the
 * next call with nobody touching anything. When the exchange just ran, the delivery is prefixed with
 * one announce line: the credential left the machine, and that must never be discoverable-only.
 */
export async function fetchUnseen(server, scope, env) {
  let auth = await getToken(server, env);
  if (!auth) return null;
  const call = (token) =>
    fetch(
      new URL(`/api/inject?scope=${encodeURIComponent(scope)}&unseen=1`, server),
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      },
    );
  try {
    let res = await call(auth.token);
    if (res.status === 401) {
      clearToken(server, env);
      auth = await getToken(server, env);
      if (!auth) return null;
      res = await call(auth.token);
    }
    const announce = auth.minted
      ? `yoke: authenticated as ${auth.minted} via GitHub — credential cached in ${env.YOKE_AUTH_DIR || "~/.yoke"}\n`
      : "";
    if (res.status === 204) return announce || null;
    if (!res.ok) return null;
    return announce + (await res.text());
  } catch (e) {
    // Same escape hatch as auth.mjs: silent by rule, explicable on demand.
    if (process.env.YOKE_DEBUG) process.stderr.write(`yoke unseen: ${e}\n`);
    return null;
  }
}
