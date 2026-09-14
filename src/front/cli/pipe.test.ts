// The one CLI test that needs a real process, because the defect it guards lives in the process exit.
//
// Everything else about this CLI is testable by calling `runCli` directly — the exit code is its return
// value and the output goes through spies. That is why this defect survived: with stdout captured in
// process there is no pipe, and a pipe is the only place it happens.
//
// `process.exit()` in the entry point discarded whatever node had buffered for a piped stdout.
// Measured on a 518-record corpus: `yoke list --json > file` wrote 444,706 bytes of
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import { createServeServer } from "../serve/index.js";

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "yoke-pipe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/…", which node then resolves
// against the cwd as "D:\D:\…".
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
/** Comfortably past a 64 KiB pipe buffer, so a truncating exit cannot pass by luck. */
const BIG = 200_000;

describe("--json survives a pipe", () => {
  it("writes the whole document to a pipe, not one buffer of it", async () => {
    const db = join(dir, "pipe.db");
    const port = new SqliteStorage(db);
    await port.init();
    const ont = seedOntology();
    const now = "2026-08-13T00:00:00Z";
    const { entity: big } = await commit(
      port,
      ont,
      { type: "fact", attributes: { statement: "x".repeat(BIG) } },
      { actor: "tester", origin: "test", occurred_at: now },
      now,
    );

    // The CLI reads through a server, so one is stood up on this store for the child to talk to.
    const server = createServeServer({
      store: port,
      defaultActor: "tester",
      auth: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const bound = (server.address() as { port: number }).port;

    // execFile gives the child a pipe for stdout — the condition under test. maxBuffer is raised so
    // that a truncation here can only come from the child.
    const { stdout } = await run(
      process.execPath,
      // `get`, not `list`: a listing returns summary rows (SPEC draws the audit line at attributes),
      // so the document that has to cross a pipe is the one read that carries a record's whole text.
      ["--import", "tsx", ENTRY, "get", big.id, "--json"],
      {
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, YOKE_SERVER: `http://127.0.0.1:${bound}` },
      },
    ).finally(() => {
      server.close();
      port.close();
    });

    expect(stdout.length).toBeGreaterThan(BIG);
    // Parsing is the assertion that matters: a truncated document is invalid JSON, which is exactly
    // what a caller piping into `jq` or a script hits.
    const parsed = JSON.parse(stdout) as {
      attributes: { statement?: string };
    };
    expect(parsed.attributes.statement).toHaveLength(BIG);
  }, 30_000);
});
