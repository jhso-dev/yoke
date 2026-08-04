import { defineConfig } from "vitest/config";

// The kuzu adapter is NOT tested under vitest: its native binding kills the
// fork's IPC channel (and segfaults the threads pool), which aborts whatever
// runs after it. Its conformance run lives in scripts/test-kuzu.mjs (main
// process, no pool) sharing the same cases via src/ports/conformance-cases.ts.
// The exclude below keeps any future kuzu *.test.ts from sneaking back into
// the pool; single fork + ignored teardown errors guard the rest of the suite
// against similar native-module races (better-sqlite3 has been well-behaved).
// Timeouts, because the defaults (5s per test, 10s per hook) are sized for tests that touch nothing
// and most of this suite does real I/O: better-sqlite3 against a temp file, a Neo4j over Bolt, an MCP
// server and client on a linked pair — all of it serialized through the single fork above, which is
// not negotiable for the reason given there.
//
// Locally the whole run is under 2s and the default is invisible. On a cold CI runner it is not, and
// windows is where it bites: measured on one run, `storage-sqlite/index.test.ts` took 11.2s for 61
// cases that finish in well under a second here.
//
// What makes this a config change rather than a per-test argument is the failure MODE. A default
// timeout lands on whichever case happened to be slowest that minute, so it reads as a defect in an
// unrelated test and reproduces nowhere. Two different tests failed on two consecutive pushes of a
// DOCS-ONLY diff — the flake was already on main and had never been observed. Patching each one as it
// surfaces is chasing instances of a single cause.
//
// This supersedes two per-test overrides, both removed with it: the MCP briefing-cap case
// (BRIEFING_LIMIT + 4 records through the real gate, each two writes, then a bulk verify — over a
// hundred sqlite transactions before its first assertion) and every storage-neo4j case (a cold
// container pays connection setup per case, and creating a vector index includes waiting for it to come
// ONLINE, since a query against a still-populating index returns nothing).
//
// Cost: a genuinely hung test blocks 30s instead of 5s. Cheap against a suite that passes in 2s, and
// far cheaper than a red main nobody can reproduce.
//
// ponytail: one number for the whole suite. A single test gets its own argument only when its slowness
// has a cause of its own — never to buy headroom that belongs here.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    dangerouslyIgnoreUnhandledErrors: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/adapters/storage-kuzu/**",
      // Next's build output would otherwise match the default test glob.
      "web/.next/**",
      "web/out/**",
    ],
  },
});
