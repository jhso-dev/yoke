#!/usr/bin/env node
// SessionStart: the working context's briefing, as plain stdout — this event is one of the few whose
// plain stdout the client adds to the model's context, so no envelope. The briefing is the full
// anchored injection (bounded by the CLI's briefing cap), and it writes the delivery row that makes
// the very next `--unseen` silent: a session is briefed once, then told only what changes.

import { readStdin, resolveScope, runInject } from "./lib.mjs";

const input = readStdin();
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const scope = resolveScope(cwd, process.env);
if (scope) {
  const out = runInject(["--scope", scope], cwd, process.env);
  if (out?.trim()) process.stdout.write(out);
}
