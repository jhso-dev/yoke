// adr connector tests (v7.1.4). Fixtures on disk, because the parsing IS the connector.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAdrConnector, sections, statedDate } from "./adr.js";

const dir = () => mkdtempSync(join(tmpdir(), "yoke-adr-"));

const collect = async (d: string) => {
  const out = [];
  for await (const item of makeAdrConnector({ dir: d }).pull()) out.push(item);
  return out;
};

const MADR = `# ADR 0007: Use Postgres for the event store

Date: 2025-03-12
Status: Accepted

## Context and Problem Statement

Event volume outgrew the single-writer sqlite file.

## Decision

Store events in Postgres, partitioned by month.

## Considered Options

- Kafka, rejected for operational weight
- DynamoDB
`;

describe("adr connector", () => {
  it("files a decision with its rationale and the options it turned down", async () => {
    const d = dir();
    writeFileSync(join(d, "0007-event-store.md"), MADR);
    const [item] = await collect(d);

    expect(item.type).toBe("decision");
    expect(item.attributes.conclusion).toBe(
      "Store events in Postgres, partitioned by month.",
    );
    expect(item.attributes.rationale).toContain("outgrew the single-writer");
    // The rejected alternatives are the half of the judgment a `fact` would have thrown away, which is
    // the whole reason this is not the notes connector.
    expect(item.attributes.rejected_alternatives).toEqual([
      "Kafka, rejected for operational weight",
      "DynamoDB",
    ]);
    expect(item.externalId).toBe("adr:0007-event-store.md");
  });

  it("dates the record from the document, never from the file", async () => {
    const d = dir();
    writeFileSync(join(d, "0007-event-store.md"), MADR);
    const [item] = await collect(d);
    // A checkout gives every ADR the same mtime, which would expire a decade of decisions on one day.
    expect(item.occurredAt).toBe("2025-03-12T00:00:00.000Z");
  });

  it("falls back to the filename's date, and refuses a date the calendar lacks", () => {
    expect(statedDate("no date line", "2024-11-02-thing.md")).toBe(
      "2024-11-02T00:00:00.000Z",
    );
    // Not silently moved to March: a bad date would otherwise become the record's whole freshness life.
    expect(statedDate("Date: 2026-02-30", "x.md")).toBeUndefined();
    expect(statedDate("nothing here", "x.md")).toBeUndefined();
  });

  it("still yields a decision when the document uses no standard headings", async () => {
    const d = dir();
    writeFileSync(
      join(d, "old.md"),
      "# Ship the mobile client as React Native\n\nWe had two RN developers and no iOS one.\n",
    );
    const [item] = await collect(d);
    // Title as conclusion: an ADR's title conventionally IS the decision, and refusing a document a
    // human clearly wrote as a decision would leave the densest source on disk unread.
    expect(item.attributes.conclusion).toBe(
      "Ship the mobile client as React Native",
    );
    expect(item.attributes.rationale).toContain("two RN developers");
    expect(item.occurredAt).toBeUndefined();
  });

  it("gives the gate a rationale even when the document has no prose", async () => {
    const d = dir();
    writeFileSync(join(d, "bare.md"), "# Adopt trunk-based development\n");
    const [item] = await collect(d);
    // `decision.rationale` is required, so an empty one would be a rejection rather than a draft.
    expect(item.attributes.rationale).toBe("Recorded in bare.md");
  });

  it("splits on headings and keeps text before the first one", () => {
    const map = sections(
      "intro line\n\n## Decision\nchose X\n### Context\nwhy\n",
    );
    expect(map.get("")).toBe("intro line");
    expect(map.get("decision")).toBe("chose X");
    expect(map.get("context")).toBe("why");
  });
});
