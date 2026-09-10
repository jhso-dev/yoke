#!/usr/bin/env node
// UserPromptSubmit and PostToolUse: what this session's working context gained or reversed since the
// session was last told — `yoke inject --unseen` (SPEC "Since, and unseen"). Nothing changed is the
// overwhelmingly common case and produces zero bytes, so the model's context carries no heartbeat.
//
// One entrypoint for both events because only the wrapper differs: plain stdout reaches the model on
// UserPromptSubmit, while PostToolUse takes only the `additionalContext` envelope (Claude Code hooks
// reference — its plain stdout goes to the debug log). The event name on stdin decides.

import { readStdin, resolveScope, runInject } from "./lib.mjs";

const input = readStdin();
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const scope = resolveScope(cwd, process.env);
if (scope) {
  const out = runInject(["--scope", scope, "--unseen"], cwd, process.env);
  if (out?.trim()) {
    process.stdout.write(
      input.hook_event_name === "PostToolUse"
        ? JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: out,
            },
          })
        : out,
    );
  }
}
