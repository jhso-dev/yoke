import { describe, expect, it } from "vitest";
import { isoFromLocalInput, localTime } from "./time";

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

describe("isoFromLocalInput", () => {
  it("reads the control's value as local time, not as UTC", () => {
    // Appending `Z` to the control's local wall time moves the queried window by the reader's whole
    // offset. Asserted by round trip so it holds in any zone: 16:43 typed into the picker must still
    // read as 16:43 on the screen it filters.
    expect(localTime(isoFromLocalInput("2026-07-30T16:43"))).toContain(
      "16:43:00",
    );
  });

  it("emits full ISO with milliseconds, which is what the server compares against", () => {
    // `at >= since` is a text compare: a since of `…:58Z` sorts after a stored `…:58.846Z` and would
    // drop rows from its own second.
    expect(isoFromLocalInput("2026-07-30T16:43")).toMatch(/\.\d{3}Z$/);
  });

  it("sends nothing for an empty or unusable control value", () => {
    // An empty filter means "no lower bound", never "the epoch" and never a crash.
    expect(isoFromLocalInput("")).toBe("");
    expect(isoFromLocalInput("2026-13-45T99:99")).toBe("");
  });
});
