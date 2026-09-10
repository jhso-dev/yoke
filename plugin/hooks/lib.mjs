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
 * The working context this repo is anchored on, or null.
 *
 * Env wins (a shell export, or a client that passes settings env through). The fallback reads the
 * repo's own `.claude/settings.json` — the documented binding (ADOPTION §3): the initiative id lives
 * in the repo, so every session in it is anchored with no per-session setup. Read from the file
 * directly rather than trusting inheritance, because whether a hook process receives settings env is
 * the client's business, and this must work from the repo alone. `settings.local.json` first: it is
 * the uncommitted, per-person file, and a person's own binding outranks the repo's.
 */
export function resolveScope(cwd, env) {
  if (env.YOKE_SCOPE) return env.YOKE_SCOPE;
  for (const f of ["settings.local.json", "settings.json"]) {
    try {
      const s = JSON.parse(readFileSync(join(cwd, ".claude", f), "utf8"));
      const v = s?.env?.YOKE_SCOPE;
      if (typeof v === "string" && v) return v;
    } catch {
      // absent or unparseable settings file — try the next one
    }
  }
  return null;
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
