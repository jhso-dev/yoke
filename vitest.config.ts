import { defineConfig } from "vitest/config";

// kuzu's native binding kills its fork's IPC channel after its test file
// completes (ERR_IPC_CHANNEL_CLOSED; threads pool segfaults outright), which
// aborts any files still queued behind it. Mitigation is two-fold:
// 1. npm test runs the kuzu file in its OWN vitest invocation (see package.json
//    test:main / test:kuzu) so nothing queues behind the dying fork.
// 2. Single fork + ignored unhandled teardown errors keep each invocation
//    deterministic. ponytail: dangerouslyIgnoreUnhandledErrors masks all
//    runner-level rejections — vitest 4's onUnhandledError would let us match
//    the exact code. Revisit when upgrading vitest or kuzu.
// Shared settings; the kuzu split lives in the two config files (not in npm
// script globs — an unquoted glob in package.json gets shell-expanded into
// positional filters, which once silently reduced `test:main` to zero files).
export const shared = {
  pool: "forks" as const,
  poolOptions: { forks: { singleFork: true } },
  dangerouslyIgnoreUnhandledErrors: true,
};

export default defineConfig({
  test: {
    ...shared,
    exclude: ["**/node_modules/**", "**/dist/**", "src/adapters/storage-kuzu/**"],
  },
});
