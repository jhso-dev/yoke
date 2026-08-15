// The encoding is the whole tool: if (document, offset) → date stops being monotone, the dates say
// nothing and every arm that reads them is measuring noise. Pure functions only — the store half is
// exercised by running the script against a copy (see its header).

import { describe, expect, it } from "vitest";
import {
  formatSession,
  locate,
  normalizeWithMap,
  ordinalDate,
  parseSource,
  splitSessions,
} from "./backfill-ordinal-dates.mjs";

const BASE = Date.parse("2025-01-01T00:00:00.000Z");
const at = (doc, offset, len = 10_000) =>
  Date.parse(ordinalDate(doc, offset, len, BASE));

describe("ordinalDate", () => {
  it("moves forward with the offset inside one document", () => {
    expect(at(0, 0)).toBeLessThan(at(0, 100));
    expect(at(0, 100)).toBeLessThan(at(0, 5_000));
    expect(at(0, 5_000)).toBeLessThan(at(0, 9_999));
  });

  it("puts the last record of a document before the first of the next", () => {
    expect(at(0, 10_000)).toBeLessThan(at(1, 0));
    expect(at(1, 10_000)).toBeLessThan(at(2, 0));
    // Across documents of very different lengths, too — the day is what orders them.
    expect(Date.parse(ordinalDate(3, 39_000, 39_000, BASE))).toBeLessThan(
      Date.parse(ordinalDate(4, 0, 800, BASE)),
    );
  });

  it("is one day per document and never leaves it", () => {
    expect(ordinalDate(2, 0, 100, BASE)).toBe("2025-01-03T00:00:00.000Z");
    expect(ordinalDate(2, 100, 100, BASE)).toBe("2025-01-03T20:00:00.000Z");
  });

  it("is a function of its inputs, so a second run rewrites nothing", () => {
    expect(ordinalDate(1, 512, 4_096, BASE)).toBe(
      ordinalDate(1, 512, 4_096, BASE),
    );
  });

  it("does not divide by a zero-length document", () => {
    expect(ordinalDate(0, 0, 0, BASE)).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("the corpus, as the harness renders it", () => {
  const turns = [
    { role: "system", content: "Persona" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "" },
    { role: "system", content: "Later" },
    { role: "user", content: "again" },
  ];

  it("opens a new session at every system turn", () => {
    const sessions = splitSessions(turns);
    expect(sessions.map((s) => s.length)).toEqual([3, 2]);
  });

  it("renders a session as [ROLE] blocks, dropping empty turns", () => {
    expect(formatSession(splitSessions(turns)[0])).toBe(
      "[SYSTEM] Persona\n\n[USER] hello",
    );
  });
});

describe("locate", () => {
  const doc = '[USER] I  moved\nto Lisbon in March, and I’ve stayed since.';

  it("finds an exact quote", () => {
    expect(locate(doc, "moved")).toEqual({ offset: 10, how: "exact" });
  });

  it("finds one the model re-spaced or re-quoted", () => {
    const found = locate(doc, "I moved to Lisbon in March, and I've stayed");
    expect(found.how).toBe("normalized");
    expect(doc.slice(found.offset, found.offset + 1)).toBe("I");
  });

  it("falls back to the longest prefix that lands", () => {
    const found = locate(
      doc,
      "I moved to Lisbon in March, and I've stayed since — and I love it there, truly",
    );
    expect(found.how).toMatch(/^partial:/);
  });

  it("says nothing rather than guessing", () => {
    expect(locate(doc, "a sentence from a different conversation entirely")).toBe(
      null,
    );
  });

  it("maps the normalized hit back to a real offset", () => {
    const { text, map } = normalizeWithMap(doc);
    expect(doc[map[text.indexOf("Lisbon")]]).toBe("L");
  });
});

describe("parseSource", () => {
  it("reads the document index and the quote the connector wrote", () => {
    expect(
      parseSource({ sources: 'raw:00003-1ee4be06.md — "I read at night."' }),
    ).toEqual({ docIndex: 3, quote: "I read at night." });
  });

  it("returns null for a record with no quoted source", () => {
    expect(parseSource({})).toBe(null);
    expect(parseSource({ sources: "slack:C123" })).toBe(null);
  });
});
