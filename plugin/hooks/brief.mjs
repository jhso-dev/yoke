#!/usr/bin/env node
// SessionStart: the working context's briefing, as plain stdout — this event is one of the few whose
// plain stdout the client adds to the model's context, so no envelope. The briefing is the full
// anchored injection (bounded by the CLI's briefing cap), and it writes the delivery row that makes
// the very next `--unseen` silent: a session is briefed once, then told only what changes.

import { fetchUnseen, readStdin, resolveScope, resolveSetting, runInject } from "./lib.mjs";

const input = readStdin();
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const scope = resolveScope(cwd, process.env);
if (scope) {
  // Against a team server the ledger is per token, and the server has no text briefing route yet, so
  // the best available SessionStart is the unseen read: a client's very first session gets the full
  // briefing (nothing was handed yet), later sessions get what changed since the last one. The gap —
  // a session that wants re-briefing on knowledge it was already handed — is stated in ADOPTION §3;
  // the MCP yoke_inject tool covers it in-session.
  const server = resolveSetting(cwd, process.env, "YOKE_SERVER");
  const out = server
    ? await fetchUnseen(server, scope, process.env)
    : runInject(["--scope", scope], cwd, process.env);
  if (out?.trim()) process.stdout.write(out);
}
