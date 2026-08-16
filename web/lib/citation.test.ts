import { describe, expect, it } from "vitest";
import { type Cited, citationLabel, shortId } from "./citation";

const ULID = "01KYR8A33HH1SRVXN2PBES70TA";
const row = (over: Partial<Cited> = {}): Cited => ({
  type: "fact",
  version: 2,
  actor: ULID,
  occurred_at: "2026-07-30T00:00:00Z",
  citation: `[fact:01KYR8A33S899N9JBT51Q91PY6@v2] ${ULID}, 2026-07-30T00:00:00Z`,
  ...over,
});

describe("citationLabel", () => {
  it("shows the name, the version and the date — and no full ULID", () => {
    const label = citationLabel(row({ actorName: "Bora" }));
    expect(label).toBe("fact@v2 · Bora · 2026-07-30");
    // What must never reach a table cell: a 26-char ULID.
    expect(label).not.toContain(ULID);
    expect(label).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("truncates an unresolved actor instead of hiding it", () => {
    // No actorName (a person record that no longer resolves) must still say who, shortened.
    const label = citationLabel(row());
    expect(label).toContain("01KYR8A3…");
    expect(label).not.toContain(ULID);
  });

  it("leaves a machine actor readable as-is", () => {
    expect(citationLabel(row({ actor: "yoke:system" }))).toBe(
      "fact@v2 · yoke:system · 2026-07-30",
    );
    expect(shortId("tester")).toBe("tester");
  });

  it("never reads the citation string — the label cannot drift from a reformatted citation", () => {
    // Same fields, deliberately mangled citation: the label must be unchanged.
    const a = citationLabel(row({ actorName: "Bora" }));
    const b = citationLabel(row({ actorName: "Bora", citation: "garbage" }));
    expect(a).toBe(b);
  });

  it("slices the date without a timezone shift", () => {
    // A late-evening UTC timestamp must not roll to the next/previous day via locale formatting.
    expect(
      citationLabel(row({ occurred_at: "2026-07-30T23:59:59Z" })),
    ).toContain("2026-07-30");
  });
});
