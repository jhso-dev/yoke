import { defineConfig } from "vitest/config";
import { shared } from "./vitest.config.js";

// The kuzu adapter tests run in their own vitest invocation (see package.json):
// kuzu's native binding kills its fork's IPC channel after the file completes,
// which would abort any test files queued behind it in a shared run.
export default defineConfig({
  test: {
    ...shared,
    include: ["src/adapters/storage-kuzu/**/*.test.ts"],
  },
});
