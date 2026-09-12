// The plugin is client-side packaging, not a third front adapter — every byte of knowledge still
// moves through the CLI these hooks spawn (invariant 3). What THIS suite pins is the packaging's own
// contract: the manifests parse and point at files that exist, a hook can never fail or spam a
// session, and the end-to-end path (brief → quiet → reversal arrives, enveloped per event) matches
// what the measured experiment saw (ROADMAP v6.2).

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../src/adapters/storage-sqlite/index.js";
import { commit } from "../src/core/commit.js";
import { deprecate } from "../src/core/lifecycle.js";
import { seedOntology } from "../src/core/ontology.js";
// @ts-expect-error — plain .mjs, typed by its JSDoc only; imported so the scope fallback is unit-tested.
import { resolveScope } from "./hooks/lib.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pluginDir = join(repo, "plugin");
const dir = mkdtempSync(join(tmpdir(), "yoke-plugin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("the plugin's manifests", () => {
  it("marketplace → plugin → hooks all parse and point at files that exist", () => {
    const market = json(join(repo, ".claude-plugin/marketplace.json"));
    expect(market.plugins.map((p: { source: string }) => p.source)).toEqual(["./plugin"]);
    expect(json(join(pluginDir, ".claude-plugin/plugin.json")).name).toBe("yoke");
    const hooks = json(join(pluginDir, "hooks/hooks.json")).hooks;
    // The three events the delivery design names (ADOPTION §3) — no more: a fourth event would run
    // the CLI at moments nothing was designed to say.
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "UserPromptSubmit"]);
    for (const groups of Object.values(hooks) as Array<{ hooks: Array<{ command: string; timeout: number }> }[]>)
      for (const g of groups)
        for (const h of g.hooks) {
          const script = h.command.replace("node ${CLAUDE_PLUGIN_ROOT}", pluginDir).trim();
          expect(() => readFileSync(script, "utf8"), script).not.toThrow();
          // A hook with no budget can stall the tool loop on a hung store.
          expect(h.timeout).toBeLessThanOrEqual(15);
        }
    expect(json(join(pluginDir, ".mcp.json")).mcpServers.yoke.args).toEqual(["mcp"]);
  });
});

describe("scope binding", () => {
  it("env wins, then the person's local settings, then the repo's", () => {
    const cwd = join(dir, "scope");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    expect(resolveScope(cwd, {})).toBeNull();
    writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({ env: { YOKE_SCOPE: "repo" } }));
    expect(resolveScope(cwd, {})).toBe("repo");
    writeFileSync(join(cwd, ".claude/settings.local.json"), JSON.stringify({ env: { YOKE_SCOPE: "mine" } }));
    expect(resolveScope(cwd, {})).toBe("mine");
    expect(resolveScope(cwd, { YOKE_SCOPE: "env" })).toBe("env");
  });
});

/** Run a hook entrypoint the way the client does: stdin JSON, stdout captured. Async on purpose —
 * the team-server case runs the serve instance in THIS process, and a spawnSync child that calls
 * back into it would deadlock against our own event loop (the real deployment is two processes). */
function runHook(
  script: string,
  stdin: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    // The ambient yoke configuration is already gone (vitest.setup.ts strips it, and children
    // inherit that), so the case's own env is the whole of what a hook sees.
    const child = spawn(process.execPath, [join(pluginDir, "hooks", script)], {
      env: { ...process.env, YOKE_SCOPE: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

describe("a hook never breaks a session", () => {
  it("no scope bound: exit 0, zero bytes", async () => {
    const cwd = join(dir, "bare");
    mkdirSync(cwd, { recursive: true });
    for (const s of ["brief.mjs", "unseen.mjs"]) {
      const r = await runHook(s, { cwd, hook_event_name: "PostToolUse" }, {});
      expect([r.status, r.out], s).toEqual([0, ""]);
    }
  });

  it("scope bound but no yoke binary: exit 0, zero bytes", async () => {
    const cwd = join(dir, "bare");
    for (const s of ["brief.mjs", "unseen.mjs"]) {
      const r = await runHook(s, { cwd, hook_event_name: "SessionStart" }, {
        YOKE_SCOPE: "some-scope",
        YOKE_BIN: join(dir, "no-such-binary"),
      });
      expect([r.status, r.out], s).toEqual([0, ""]);
    }
  });
});

describe.skipIf(process.platform === "win32")("end to end against the real CLI", () => {
  it("briefs once, goes quiet, and a reversal arrives enveloped per event", async () => {
    const cwd = join(dir, "proj");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const db = join(cwd, "yoke.db");
    // The binding the setup skill writes — the hooks must find it with no env var at all.
    writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({ env: { YOKE_SCOPE: "" } }));

    const now = new Date().toISOString();
    const prov = { actor: "po", origin: "cli", occurred_at: now };
    const store = new SqliteStorage(db);
    await store.init();
    await store.saveOntology(seedOntology());
    const ont = store.loadOntology();
    const scope = (await commit(store, ont, { type: "collaboration", attributes: { title: "PROJ-1" } }, prov, now)).entity.id;
    const d1 = (
      await commit(store, ont, { type: "fact", attributes: { statement: "PG is Toss" } }, prov, now, { attachTo: scope })
    ).entity.id;
    store.close();
    writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({ env: { YOKE_SCOPE: scope } }));

    // The CLI behind YOKE_BIN, via tsx: the test must not depend on `npm run build` having run.
    const bin = join(dir, "yoke-wrapper");
    writeFileSync(
      bin,
      `#!/bin/sh\nexec "${join(repo, "node_modules/.bin/tsx")}" "${join(repo, "src/front/cli/index.ts")}" "$@"\n`,
    );
    chmodSync(bin, 0o755);
    const env = { YOKE_BIN: bin, YOKE_DB: db, YOKE_NO_AUTO_EMBED: "1", YOKE_ACTOR: "fe" };

    // 1. SessionStart: the briefing, plain.
    const brief = await runHook("brief.mjs", { cwd, hook_event_name: "SessionStart" }, env);
    expect(brief.status).toBe(0);
    expect(brief.out).toContain("PG is Toss");
    // 2. Nothing changed: zero bytes — the common case must cost the context nothing.
    expect((await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env)).out).toBe("");
    // 3. The reversal, with its reason, arrives enveloped on PostToolUse…
    const store2 = new SqliteStorage(db);
    await store2.init();
    await deprecate(store2, [d1], "po", new Date().toISOString(), undefined, "Toss said no");
    store2.close();
    const post = await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env);
    const envelope = JSON.parse(post.out).hookSpecificOutput;
    expect(envelope.hookEventName).toBe("PostToolUse");
    expect(envelope.additionalContext).toContain("changed since handed to you");
    expect(envelope.additionalContext).toContain(`${d1}  PG is Toss  -> deprecated: Toss said no`);
    // …and reported once: the delivery row moved the bound.
    expect((await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env)).out).toBe("");
    // 4. On UserPromptSubmit the same read is plain stdout, never a JSON envelope.
    const store3 = new SqliteStorage(db);
    await store3.init();
    const ts = new Date().toISOString();
    const d2 = (
      await commit(
        store3,
        store3.loadOntology(),
        { type: "fact", attributes: { statement: "PG is Nice" } },
        { ...prov, occurred_at: ts },
        ts,
        { attachTo: scope },
      )
    ).entity.id;
    store3.close();
    const prompt = await runHook("unseen.mjs", { cwd, hook_event_name: "UserPromptSubmit" }, env);
    expect(prompt.out).toContain("-- new in");
    expect(prompt.out).toContain("PG is Nice");
    expect(prompt.out.trimStart().startsWith("{")).toBe(false);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("zero-action credential against a real team server", () => {
  it("first contact exchanges gh → yoke token (announced once), delivers, heals a revocation", async () => {
    const { createServer } = await import("node:http");
    const { createServeServer } = await import("../src/front/serve/index.js");
    const listen = (srv: import("node:http").Server) =>
      new Promise<{ base: string; close: () => void }>((resolve) =>
        srv.listen(0, () =>
          resolve({
            base: `http://localhost:${(srv.address() as { port: number }).port}`,
            close: () => srv.close(),
          }),
        ),
      );

    // api.github.com's stand-in: one known token, one login, an active member of "acme".
    const gh = await listen(
      createServer((req, res) => {
        const ok = (req.headers.authorization ?? "") === "Bearer gh_alice";
        const send = (code: number, body: unknown) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (!ok) return send(401, { message: "Bad credentials" });
        if (req.url === "/user") return send(200, { login: "alice" });
        return send(200, { state: "active" });
      }),
    );

    // A real serve --auth over a seeded store; po acts over HTTP like any other client.
    const cwd = join(dir, "team-proj");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    const now = new Date().toISOString();
    const prov = { actor: "po", origin: "cli", occurred_at: now };
    const store = new SqliteStorage(join(cwd, "server.db"));
    await store.init();
    await store.saveOntology(seedOntology());
    const ont = store.loadOntology();
    const scope = (await commit(store, ont, { type: "collaboration", attributes: { title: "PROJ-1" } }, prov, now)).entity.id;
    const d1 = (
      await commit(store, ont, { type: "fact", attributes: { statement: "PG is Toss" } }, prov, now, { attachTo: scope })
    ).entity.id;
    const po = store.createToken({ name: "po", scopes: ["read", "write"], created_at: now }).token;
    const run = await listen(
      createServeServer({
        store,
        defaultActor: "yoke:system",
        auth: true,
        github: { org: "acme", api: gh.base },
      }),
    );

    // The developer machine: a fake `gh` that prints the token, a private auth cache, the repo binding.
    const ghBin = join(dir, "fake-gh");
    writeFileSync(ghBin, `#!/bin/sh\necho gh_alice\n`);
    chmodSync(ghBin, 0o755);
    const authDir = join(dir, "auth-cache");
    writeFileSync(
      join(cwd, ".claude/settings.json"),
      JSON.stringify({ env: { YOKE_SCOPE: scope, YOKE_SERVER: run.base } }),
    );
    const env = { YOKE_GH_BIN: ghBin, YOKE_AUTH_DIR: authDir };

    try {
      // 1. First contact: exchange + briefing, and the credential's movement is announced ONCE.
      const first = await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env);
      expect(first.status).toBe(0);
      const ctx = JSON.parse(first.out).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain("authenticated as alice via GitHub");
      expect(ctx).toContain("PG is Toss");
      // The minted credential is on disk, owner-only, and is a yoke token — not the gh one.
      const cached = readFileSync(join(authDir, readdirSync(authDir)[0]), "utf8");
      expect(JSON.parse(cached).token).toMatch(/^yk_/);
      expect(cached).not.toContain("gh_alice");
      // 2. Quiet, and no second announce.
      expect((await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env)).out).toBe("");
      // 3. PO reverses over HTTP; the hook delivers with the reason.
      const dep = await fetch(`${run.base}/api/deprecate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${po}` },
        body: JSON.stringify({ ids: [d1], reason: "Toss said no" }),
      });
      expect(dep.status).toBe(200);
      const third = await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, env);
      expect(JSON.parse(third.out).hookSpecificOutput.additionalContext).toContain(
        `${d1}  PG is Toss  -> deprecated: Toss said no`,
      );
      // 4. Revoked server-side: the next delivery re-exchanges on its own — announced again, nothing touched.
      expect(store.revokeToken("github:alice")).toBe(true);
      const ts2 = new Date().toISOString();
      const d2 = (
        await commit(store, store.loadOntology(), { type: "fact", attributes: { statement: "PG is Nice" } }, { ...prov, occurred_at: ts2 }, ts2, { attachTo: scope })
      ).entity.id;
      const healed = await runHook("unseen.mjs", { cwd, hook_event_name: "UserPromptSubmit" }, env);
      expect(healed.out).toContain("authenticated as alice via GitHub");
      expect(healed.out).toContain("PG is Nice");
      // 5. No gh on the machine and no cache: silence, exactly like every other missing precondition.
      rmSync(authDir, { recursive: true, force: true });
      const bare = await runHook("unseen.mjs", { cwd, hook_event_name: "PostToolUse" }, { YOKE_GH_BIN: join(dir, "nope"), YOKE_AUTH_DIR: authDir });
      expect([bare.status, bare.out]).toEqual([0, ""]);
    } finally {
      run.close();
      gh.close();
      store.close();
    }
  }, 60_000);
});
