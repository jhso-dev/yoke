import { defineConfig } from "vitest/config";

// Single-fork pool: kuzu's native binding races vitest's multi-worker IPC at
// teardown on Linux (ERR_IPC_CHANNEL_CLOSED after all tests pass). Serializing
// test files into one child process avoids the race; the suite is small enough
// that the wall-clock cost is negligible.
// ponytail: single fork. If the suite outgrows this, isolate the kuzu tests
// into their own pool via poolMatchGlobs instead.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
