import { defineConfig } from "vitest/config";

// The kuzu adapter is NOT tested under vitest: its native binding kills the
// fork's IPC channel (and segfaults the threads pool), which aborts whatever
// runs after it. Its conformance run lives in scripts/test-kuzu.mjs (main
// process, no pool) sharing the same cases via src/ports/conformance-cases.ts.
// The exclude below keeps any future kuzu *.test.ts from sneaking back into
// the pool; single fork + ignored teardown errors guard the rest of the suite
// against similar native-module races (better-sqlite3 has been well-behaved).
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    dangerouslyIgnoreUnhandledErrors: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/adapters/storage-kuzu/**",
    ],
  },
});
