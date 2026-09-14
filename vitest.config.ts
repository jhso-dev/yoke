import { defineConfig } from "vitest/config";

// Single fork: a native binding that dies badly takes the pool's IPC channel with it and aborts
// whatever ran after it. 30s timeouts rather than vitest's 5s/10s: this suite does real I/O — a
// better-sqlite3 temp file, an OpenSearch cluster over REST, a linked MCP pair — all serialized
// through that one fork. Measured on a cold windows runner, storage-sqlite/index.test.ts took 11.2s
// for 61 cases that finish under a second locally, so the default lands on whichever case happened
// to be slowest that minute and reads as a defect in an unrelated test.
//
// ceiling: one number for the whole suite. A single test gets its own argument only when its
// slowness has a cause of its own — never to buy headroom that belongs here.
export default defineConfig({
  test: {
    // An unconfigured embedder probes a local Ollama (core/embedding `resolveEmbedConfig`), so on a
    // developer machine that happens to be running one the suite would embed for real — different
    // results here than in CI, from a service the tests never asked for. Opting out makes "no
    // embedder configured" mean the same thing everywhere. Cases that exercise the probe inject
    // their own fetch and pass their own env, so this does not hide it.
    env: { YOKE_NO_AUTO_EMBED: "1" },
    // …and for the same reason, nothing ELSE about yoke may arrive from the machine either. See
    // vitest.setup.ts: a repo bound to a team server exports its binding into everything the client
    // spawns, and inherited it steers the code under test.
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    dangerouslyIgnoreUnhandledErrors: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Agent worktrees nest a full checkout (with its own tests and its own biome root) inside the
      // repo; without this, `npm test` in the outer repo runs the inner copy's suite too — measured:
      // 1156 tests instead of 542, with cross-fork mock leaks as bonus failures.
      ".claude/**",
      // Next's build output would otherwise match the default test glob.
      "web/.next/**",
      "web/out/**",
    ],
  },
});
