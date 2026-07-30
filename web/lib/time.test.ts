import { describe, expect, it } from "vitest";
import { localTime } from "./time";

// Deliberately zone-agnostic: the runner's TZ is not ours to pin (CI, Windows and a laptop all differ),
// and pinning it would test the harness rather than the formatter. What is asserted instead is every
// property the columns depend on.
describe("localTime", () => {
  it("renders one fixed, column-alignable shape with the zone named", () => {
    // A bare time with no zone marker is the ambiguity this replaced, so the zone is part of the shape.
    expect(localTime("2026-07-30T07:43:58.846Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/,
    );
  });

  it("drops the milliseconds that made the raw string unreadable", () => {
    expect(localTime("2026-07-30T07:43:58.846Z")).not.toContain("846");
  });

  it("reads the same for one instant however it was written", () => {
    // The real invariant, and the one a hand-rolled offset calculation would break: these two strings
    // are the same moment, so they must not render as two different times.
    expect(localTime("2026-07-30T07:43:58Z")).toBe(
      localTime("2026-07-30T16:43:58+09:00"),
    );
  });

  it("shows an unparseable value rather than 'Invalid Date'", () => {
    expect(localTime("whenever")).toBe("whenever");
  });
});
