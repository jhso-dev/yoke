// The one CLI test that needs a real process, because the defect it guards lives in the process exit.
//
// Everything else about this CLI is testable by calling `runCli` directly — the exit code is its return
// value and the output goes through spies. That is why this defect survived: with stdout captured in
// process there is no pipe, and a pipe is the only place it happens.
//
// `process.exit()` in the entry point discarded whatever node had buffered for a piped stdout.
// Measured on a 518-record corpus before the fix: `yoke list --json > file` wrote 444,706 bytes of
// valid JSON, and the same command through `| jq` received exactly 65,536 — one pipe buffer — with
// exit 0 and no error. Every script reading `--json`, and every agent shelling out to one, silently
// received a prefix of the corpus.
//
// The subprocess runs the TypeScript entry point through tsx rather than `dist/`, so the test does not
// depend on a build having happened. One spawn (~0.5s): the corpus is prepared in process, and only
// the read that has to cross a pipe pays for a real one.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "yoke-pipe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ENTRY = new URL("./index.ts", import.meta.url).pathname;
/** Comfortably past a 64 KiB pipe buffer, so a truncating exit cannot pass by luck. */
const BIG = 200_000;

describe("--json survives a pipe", () => {
  it("writes the whole document to a pipe, not one buffer of it", async () => {
    const db = join(dir, "pipe.db");
    const port = new SqliteStorage(db);
    await port.init();
    const ont = seedOntology();
    const now = "2026-08-13T00:00:00Z";
    await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "x".repeat(BIG) } },
      { actor: "tester", origin: "test", occurred_at: now },
      now,
    );
    port.close();

    // execFile gives the child a pipe for stdout — the condition under test. maxBuffer is raised so
    // that a truncation here can only come from the child.
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", ENTRY, "--db", db, "list", "--json"],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    expect(stdout.length).toBeGreaterThan(BIG);
    // Parsing is the assertion that matters: a truncated document is invalid JSON, which is exactly
    // what a caller piping into `jq` or a script hits.
    const parsed = JSON.parse(stdout) as {
      items: Array<{ attributes: { statement?: string } }>;
    };
    const statement = parsed.items.find((e) => e.attributes.statement)
      ?.attributes.statement;
    expect(statement).toHaveLength(BIG);
  }, 30_000);
});
