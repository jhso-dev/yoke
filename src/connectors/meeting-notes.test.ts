// meeting-notes connector tests (PLAN 8.5). A temp-dir fixture with .md/.txt files (plus one ignored
// extension). Verifies chunking, external_id shape, and ingest idempotency.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { verify } from "../core/lifecycle.js";
import { seedOntology } from "../core/ontology.js";
import type { Entity } from "../core/types.js";
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
      updated: 0,
      skipped: 0,
    });
    expect(await ingest(port, ont, connector, "alice", now)).toEqual({
      added: 0,
      updated: 0,
      skipped: 3,
    });
  });
});

// Presence of the key was the whole check, so an EDITED source item was skipped. Measured on a
// transcript: one paragraph corrected and a section appended, re-ingested as "added 2, skipped 24" —
// the database kept the wrong number and the appended section arrived as a NEW record contradicting it,
// with no supersedes, no conflict flag, and nothing saying a stored chunk no longer matched its source.
describe("a corrected transcript is re-versioned, not skipped", () => {
  /** Its own directory, so editing a file cannot disturb the shared fixture above. */
  function scratch(body: string): string {
    const d = mkdtempSync(join(tmpdir(), "yoke-edit-"));
    writeFileSync(join(d, "weekly.md"), body);
    return d;
  }

  it("commits a new version when a chunk's text changed", async () => {
    const d = scratch("# Weekly\n\nWe cap webhook retries at 5 attempts.\n");
    const first = await ingest(
      port,
      ont,
      makeNotesConnector({ dir: d }),
      "alice",
      now,
    );
    expect(first).toEqual({ added: 2, updated: 0, skipped: 0 });

    writeFileSync(
      join(d, "weekly.md"),
      "# Weekly\n\nWe cap webhook retries at 3 attempts (CORRECTED).\n",
    );
    const second = await ingest(
      port,
      ont,
      makeNotesConnector({ dir: d }),
      "alice",
      now,
    );
    // The heading is unchanged and skipped; the corrected paragraph is a new version of the record it
    // corrects, rather than a second record that disagrees with the first.
    expect(second).toEqual({ added: 0, updated: 1, skipped: 1 });

    const stored = (await port.search({ text: "webhook retries" })).filter(
      (e) => typeof e.attributes.external_id === "string",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].version).toBe(2);
    expect(stored[0].attributes.statement).toContain("3 attempts");
    // Append-only: the wrong number is still readable at v1.
    const v1 = await port.getEntity(stored[0].id, 1);
    expect(v1?.attributes.statement).toContain("5 attempts");
    rmSync(d, { recursive: true, force: true });
  });

  it("a narrowed mapping does not delete the fields it stopped emitting, and re-opens what it changed", async () => {
    // The reachable cause is a connector whose FIELD SET narrowed between runs — an `--attr` mapping
    // edited to drop a column, a connector upgraded to emit less. Driven through `ingest` both times,
    // because a scenario that needs a direct `putEntity` to set up is a scenario the product cannot
    // produce, and pinning one of those proves nothing about the product.
    const item = (statement: string, extra: Record<string, unknown>) => ({
      name: "narrowing",
      async *pull() {
        yield {
          type: "fact",
          attributes: { statement, ...extra },
          externalId: "src:weekly:1",
        };
      },
    });
    const wide = item("we cap webhook retries at 5 attempts", {
      title: "retry policy",
    });
    await ingest(port, ont, wide, "alice", now);
    const found = (await port.search({ text: "webhook retries" })).filter(
      (e) => typeof e.attributes.external_id === "string",
    );
    expect(found).toHaveLength(1);
    const id = found[0].id;
    await verify(port, [id], "reviewer", now);

    // Next run: `title` is no longer mapped, and the statement was corrected at the source.
    const narrow = item("we cap webhook retries at 3 attempts (CORRECTED)", {});
    expect(await ingest(port, ont, narrow, "alice", now)).toMatchObject({
      updated: 1,
    });

    const after = (await port.getEntity(id)) as Entity;
    // The field the source still owns is overwritten; the one it stopped emitting is not deleted.
    expect(after.attributes.statement).toContain("3 attempts");
    expect(after.attributes.title).toBe("retry policy");
    // And the promotion does NOT carry across: the text someone vouched for is not the text now
    // stored, so the record goes back through review rather than staying 'verified' about new content.
    expect(after.status).toBe("draft");
  });

  it("still skips an unchanged re-ingest, so a cron job is not a version generator", async () => {
    const d = scratch("# Weekly\n\nNothing changed here.\n");
    await ingest(port, ont, makeNotesConnector({ dir: d }), "alice", now);
    expect(
      await ingest(port, ont, makeNotesConnector({ dir: d }), "alice", now),
    ).toEqual({ added: 0, updated: 0, skipped: 2 });
    rmSync(d, { recursive: true, force: true });
  });

  it("does not revert an edit a reviewer made by hand", async () => {
    // Only the attributes the connector produced are compared, so a field the source does not know
    // about cannot be silently rolled back by a re-ingest.
    const d = scratch("# Weekly\n\nThe gateway retries twice.\n");
    await ingest(port, ont, makeNotesConnector({ dir: d }), "alice", now);
    const [rec] = (await port.search({ text: "gateway retries" })).filter(
      (e) => typeof e.attributes.external_id === "string",
    );
    await port.putEntity({
      ...rec,
      version: rec.version + 1,
      attributes: { ...rec.attributes, title: "a title a human added" },
    });
    expect(
      await ingest(port, ont, makeNotesConnector({ dir: d }), "alice", now),
    ).toEqual({ added: 0, updated: 0, skipped: 2 });
    expect((await port.getEntity(rec.id))?.attributes.title).toBe(
      "a title a human added",
    );
    rmSync(d, { recursive: true, force: true });
  });
});
