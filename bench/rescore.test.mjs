import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rescore } from "./rescore.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));

// Two committed arms, and the scorer has to behave differently on them for the right reason.
describe("rescore", () => {
  it("agrees with the harness when the arm had context", () => {
    // Nothing was short-circuited here, so a second scorer that disagrees is a second scorer that is
    // wrong — this is what keeps the re-scored floor comparable to the harness-scored memory arm.
    for (const f of [
      "./results-p6-g26-best-u1-2026-08-15.json",
      "./results-p6-g26-best-u2-2026-08-15.json",
    ]) {
      const r = rescore(load(f));
      expect(r.rescored).toBe(r.harness);
      expect(r.emptyContext).toBe(0);
    }
  });

  it("recovers the floor the harness reported as zero", () => {
    // `runner.py` scores an empty-context arm wrong before the MCQ scorer runs, so the no-memory arm
    // reports 0 while having answered 25 of 42. That zero is the denominator of every published lift.
    const u1 = rescore(load("./results-p7-floor-e4b-u1-2026-08-15.json"));
    const u2 = rescore(load("./results-p7-floor-e4b-u2-2026-08-15.json"));
    expect(u1.harness + u2.harness).toBe(0);
    expect(u1.rescored + u2.rescored).toBe(25);
    expect(u1.n + u2.n).toBe(42);
    // An unanswered question is not a wrong one; a floor resting on them would not be a floor.
    expect(u1.unanswered + u2.unanswered).toBe(0);
  });
});
