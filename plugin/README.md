# yoke — Claude Code plugin

Working-context knowledge for coding agents, wired into the client so nobody has to remember to ask:

- **SessionStart** — the session opens with its working context's briefing (`yoke inject --scope`),
  citations and contradiction markers included.
- **UserPromptSubmit / PostToolUse** — between tool calls the session is told what the context
  gained or reversed since it was last told (`yoke inject --scope --unseen`): a record it was handed
  that has since been retired (with the reason), replaced or contradicted comes first, then what is
  new. Nothing changed prints nothing — the common case costs zero context.
- **MCP** — registers `yoke mcp`, so the agent also gets the query/commit tools and the in-band
  knowledge-loop instructions.
- **`/yoke:setup`** — binds a repository to its working context (writes `YOKE_SCOPE` into the repo's
  `.claude/settings.json` env) and proves the wiring end to end.

Measured behaviour of the delta line is recorded in the repo's `docs/ROADMAP.md` (v6.2): an agent
with work already on disk stops and asks; one with nothing sunk carries on with the new decision.
The wording of that line is what splits the two — do not "tidy" it.

## Install

```
claude plugin marketplace add jhso-dev/yoke
claude plugin install yoke@yoke
```

Then, in each repository, run `/yoke:setup` once. The hooks are silent until a scope is bound and the
`yoke` CLI is on PATH (`YOKE_BIN=<path>` overrides), and they never fail a session: missing binary,
missing scope, or an unreachable store all mean "no context this round".

## Configuration

| where | key | meaning |
|---|---|---|
| repo `.claude/settings.json` `env` | `YOKE_SCOPE` | the collaboration this repo's sessions anchor on |
| `.claude/settings.local.json` `env` | `YOKE_ACTOR` | who this client is — the audit trail records who was told what |
| env | `YOKE_BIN` | path to the yoke CLI when it is not on PATH |
| env / repo `.env` | `YOKE_DB`, `YOKE_POSTGRES_URL`, … | which store — the CLI's normal contract, unchanged |

Other MCP clients get the same behaviour by wiring the same two commands into their own hook
surface — the snippet lives in `docs/ADOPTION.md` §3, along with the `curl` variant for a team
`yoke serve` deployment.
