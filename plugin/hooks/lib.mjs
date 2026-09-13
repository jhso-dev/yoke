// Shared by the two hook entrypoints. Node core only — this runs on every tool call of every
// session in a repo that installed the plugin, so its one hard rule is: NEVER break a session.
// No scope bound, no yoke binary on this machine, an unreachable store — each means "print
// nothing, exit 0", not an error a person has to dismiss. The setup skill is where wiring is
// checked out loud; a hook is not the place to complain.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 * The ONLY way this plugin reaches knowledge, in both deployments: with `YOKE_SERVER` bound the CLI
 * talks to the team server under a credential it acquires from the developer's `gh` login, and
 * without it the CLI opens the local store. A hook does not need to know which, and must not hold a
 * second HTTP client and a second credential cache to find out.
 *
 * `YOKE_BIN` overrides the binary for a machine where `yoke` is not on PATH (and for tests). Every
 * failure — ENOENT, non-zero exit, the spawn timeout — is null: which store the CLI opens, and why
 * it could not, are the CLI's own environment contract (YOKE_DB, .env, YOKE_SERVER), not something
 * a hook should second-guess. The timeout is inside the client's hooks.json budget on purpose, so
 * the failure mode is "no context this round", never a stalled session.
 */
export function runInject(args, cwd, env) {
  // The repo's settings file is where a team binds its server (ADOPTION §3), and whether a hook
  // process inherits settings env is the client's business — so the value is read from the file and
  // handed to the child explicitly. Without this the CLI would open a local store on a machine whose
  // repo says otherwise, and quietly answer out of the wrong corpus.
  const server = resolveSetting(cwd, env, "YOKE_SERVER");
  const r = spawnSync(env.YOKE_BIN || "yoke", ["inject", ...args], {
    cwd,
    env: server ? { ...env, YOKE_SERVER: server } : env,
    encoding: "utf8",
    timeout: 8000,
  });
  if (r.error || r.status !== 0) {
    // The silence rule hides real failures too — an unreachable server, a `gh` login that lapsed —
    // and a hook has no other channel. This is the one escape hatch: the CLI's own message, on
    // stderr, which the client keeps in its debug log without touching the model's context.
    if (env.YOKE_DEBUG)
      process.stderr.write(`yoke inject: ${r.error ?? r.stderr ?? `exit ${r.status}`}\n`);
    return null;
  }
  return r.stdout ?? "";
}
