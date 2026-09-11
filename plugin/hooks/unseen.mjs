#!/usr/bin/env node
// UserPromptSubmit and PostToolUse: what this session's working context gained or reversed since the
// session was last told — `yoke inject --unseen` (SPEC "Since, and unseen"). Nothing changed is the
// overwhelmingly common case and produces zero bytes, so the model's context carries no heartbeat.
//
// One entrypoint for both events because only the wrapper differs: plain stdout reaches the model on
// UserPromptSubmit, while PostToolUse takes only the `additionalContext` envelope (Claude Code hooks
// reference — its plain stdout goes to the debug log). The event name on stdin decides.

import { fetchUnseen, readStdin, resolveScope, resolveSetting, runInject } from "./lib.mjs";

const input = readStdin();
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
const scope = resolveScope(cwd, process.env);
if (scope) {
  // A bound YOKE_SERVER means the deliveries ledger lives there (per token), so ask the server;
  // otherwise the CLI reads this client's own trail. Same lines either way — one unseenReport.
  const server = resolveSetting(cwd, process.env, "YOKE_SERVER");
  const out = server
    ? await fetchUnseen(server, scope, process.env)
    : runInject(["--scope", scope, "--unseen"], cwd, process.env);
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
