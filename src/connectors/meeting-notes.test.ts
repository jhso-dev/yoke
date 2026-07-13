// meeting-notes connector tests (PLAN 8.5). A temp-dir fixture with .md/.txt files (plus one ignored
// extension). Verifies chunking, external_id shape, and ingest idempotency.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { seedOntology } from "../core/ontology.js";
import { ingest } from "./ingest.js";
import { makeNotesConnector, splitChunks } from "./meeting-notes.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-notes-"));
writeFileSync(
  join(dir, "standup.md"),
  "# Standup 7/13\nalice: shipping audit log\n\nbob: reviewing slack connector\n",
);
writeFileSync(join(dir, "notes.txt"), "decided to keep chunking dumb\n");
writeFileSync(join(dir, "ignore.pdf"), "binary-ish");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ont = seedOntology();
const now = "2026-07-13T00:00:00Z";

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

describe("splitChunks", () => {
  it("splits on headings and blank lines, drops empties", () => {
    expect(splitChunks("# H\nbody\n\npara two\n# H2\nmore\n\n\n")).toEqual([
      "# H\nbody",
      "para two",
      "# H2\nmore",
    ]);
  });
});

describe("meeting-notes connector", () => {
  it("maps chunks to draft facts with file:<relpath>#<index> ids", async () => {
    const connector = makeNotesConnector({ dir });
    const items = [];
    for await (const item of connector.pull()) items.push(item);

    // sorted file order: notes.txt then standup.md; ignore.pdf skipped
    expect(items.map((i) => i.externalId)).toEqual([
      "file:notes.txt#0",
      "file:standup.md#0",
      "file:standup.md#1",
    ]);
    const standup = items[1];
    expect(standup.type).toBe("fact");
    expect(standup.attributes.statement).toBe(
      "# Standup 7/13\nalice: shipping audit log",
    );
    expect(standup.attributes.source_file).toBe("standup.md");
    expect(standup.attributes.external_id).toBe("file:standup.md#0");
  });

  it("ingest is idempotent on re-run", async () => {
    const connector = makeNotesConnector({ dir });
    expect(await ingest(port, ont, connector, "alice", now)).toEqual({
      added: 3,
      skipped: 0,
    });
    expect(await ingest(port, ont, connector, "alice", now)).toEqual({
      added: 0,
      skipped: 3,
    });
  });
});
