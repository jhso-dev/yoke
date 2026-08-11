import { describe, expect, it } from "vitest";
import { en } from "./i18n/en";
import { ko } from "./i18n/ko";
import { isInjectable, statusStyle } from "./status";
import type { Status } from "./types";

describe("statusStyle", () => {
  it("gives every status a text label, not colour alone", () => {
    for (const s of ["draft", "verified", "stale", "deprecated"] as Status[]) {
      const style = statusStyle(s);
      expect(style.label).toBeTruthy();
      expect(style.glyph).toBeTruthy();
      expect(style.tone).toBe(s);
      // The explanation lives in the catalogs, not here — every tone must have one in every locale,
      // because the alternative (what shipped) was an English sentence on the Korean UI that no
      // guard could see.
      expect(en.status.meaning[style.tone]).toBeTruthy();
      expect(ko.status.meaning[style.tone]).toBeTruthy();
    }
  });

  it("has a meaning for the unknown tone too", () => {
    const style = statusStyle("quarantined");
    expect(en.status.meaning[style.tone]).toBeTruthy();
    expect(ko.status.meaning[style.tone]).toBeTruthy();
  });

  it("degrades to a readable label for a status it has never seen", () => {
    // A future ontology-level status must render as itself rather than as blank.
    const style = statusStyle("quarantined");
    expect(style.label).toBe("quarantined");
    expect(style.tone).toBe("unknown");
  });

  it("marks only verified as injectable — the injection filter, restated for display", () => {
    expect(isInjectable("verified")).toBe(true);
    for (const s of ["draft", "stale", "deprecated"]) {
      expect(isInjectable(s)).toBe(false);
    }
  });
});
