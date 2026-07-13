#!/usr/bin/env node
// kuzu's native binding sometimes kills its vitest fork AFTER the tests pass
// (ERR_IPC_CHANNEL_CLOSED — worse on Linux), corrupting the exit code. So we
// judge the run by its JSON report, not its exit code: success = the report
// exists, ran at least one test, and none failed. A crash BEFORE the report is
// written still fails (no report / zero tests).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "yoke-kuzu-report-"));
const report = join(dir, "report.json");

const r = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "--config",
    "vitest.kuzu.config.ts",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);

let ok = false;
try {
  const j = JSON.parse(readFileSync(report, "utf8"));
  ok = j.numTotalTests > 0 && j.numFailedTests === 0 && j.numTotalTestSuites > 0;
  console.log(
    `kuzu suite: ${j.numPassedTests}/${j.numTotalTests} passed` +
      (r.status === 0 ? "" : " (post-success native teardown crash tolerated)"),
  );
} catch {
  console.error("kuzu suite: no test report produced — treating as failure");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
