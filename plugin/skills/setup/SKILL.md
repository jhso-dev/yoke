---
name: setup
description: Bind this repository to its yoke working context so the plugin's hooks start delivering — checks the yoke CLI, the store, and the collaboration record, then writes YOKE_SCOPE into the repo's .claude/settings.json. Use when the user asks to set up yoke, connect this repo to yoke, or when the hooks are installed but silent.
---

# yoke setup — bind this repo to its working context

The plugin's hooks are deliberately silent when anything is missing, so this skill is where wiring is
checked out loud. Work through the steps in order and stop at the first one that needs the user.

## 1. The CLI

Run `yoke --version`. If it is not on PATH, the hooks are no-ops. Point the user at the yoke
repository's 60-second quickstart (clone → `npm install` → `npm run build` → `npm link`), or ask
where the binary lives and use `YOKE_BIN=<path>` in step 4 instead. Do not guess an npm package
name — `yoke` on npm is an unrelated package.

## 2. The store

`yoke inject --scope x` against the intended store must fail on the SCOPE, not on the store. Which
store this repo uses is the CLI's normal environment contract, in the repo's `.env` or exported:
nothing set means `./yoke.db` in the repo; a team store is `YOKE_POSTGRES_URL`/`YOKE_OPENSEARCH_URL`
(knowledge remote, this client's trail local). If the local file does not exist yet, `yoke init`.

## 3. The working context

`yoke list --type collaboration` — the anchor must be a real record. If the initiative has none,
create it with the user's wording, and have the user confirm the wording first — it is live the
moment it is filed:

```
yoke add collaboration --actor <user> --attr title=<key> --attr summary="…"
```

## 4. The binding

Write the scope into the repo's `.claude/settings.json` under `env` — merge with what is there,
never clobber:

```json
{ "env": { "YOKE_SCOPE": "<collaboration id or key>" } }
```

Per-person values (`YOKE_ACTOR=<their id>`, so the audit trail says who was told what; `YOKE_BIN` if
needed) go in `.claude/settings.local.json`, which is not committed.

## 4b. A team server instead of a local store

If the team runs `yoke serve --auth`, bind `YOKE_SERVER` next to `YOKE_SCOPE` in step 4 and skip
step 2's local store. No credential to paste: the first delivery exchanges the developer's `gh`
login for a yoke token automatically (the server must set `YOKE_GITHUB_ORG`). Check the
preconditions out loud here: `gh auth token` must print a token, and
`curl -s -X POST "$YOKE_SERVER/api/login/github" -H "Authorization: Bearer $(gh auth token)"` must
answer JSON with a `token` — a 403 names the org the user is not a member of, and a 404 means the
server has not enabled the exchange. `YOKE_DEBUG=1` on a hook explains failures on stderr.

## 4c. On a team server, point the AGENT at the server too

The hooks follow `YOKE_SERVER`, but this plugin also registers `yoke mcp`, which opens a LOCAL
store. Left alone on a team deployment that splits the loop in half: the session is briefed from the
team's knowledge and files what it learns into a SQLite file nobody else will ever read. Register the
server's MCP endpoint and say which one the agent is to use:

```
claude mcp add --scope user --transport http yoke-team "$YOKE_SERVER/mcp" \
  --header "Authorization: Bearer <a token from 'yoke token create --name mcp-<who> --scopes read,write'>"
```

A GitHub-exchanged credential works too, but a later exchange replaces it (SPEC "GitHub exchange"),
which reads as a sudden 401 — a token minted for this purpose does not move. Then check the write
actually lands on the server: commit something through the agent's tool and confirm it comes back
from `GET $YOKE_SERVER/api/entity/<id>`. If it does not, the agent used the local one.

## 5. Prove it

`yoke inject --scope <scope>` must print the briefing. Then tell the user what to expect: the next
session opens with that briefing (SessionStart), and while a session runs, changes to the context —
new verified knowledge, a retirement with its reason, a reversal — arrive between tool calls, only
when there is something. A quiet session means nothing changed, not a broken hook; re-run step 5 to
tell the two apart.
