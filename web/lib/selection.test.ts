import { describe, expect, it } from "vitest";
import { headerCheckState } from "./selection";

describe("headerCheckState", () => {
  it("is unchecked when nothing is chosen", () => {
    expect(headerCheckState(3, 0)).toEqual({
      checked: false,
      indeterminate: false,
    });
  });

  it("is indeterminate on a partial selection", () => {
    expect(headerCheckState(3, 1)).toEqual({
      checked: false,
      indeterminate: true,
    });
  });

  it("is checked when every row is chosen", () => {
    expect(headerCheckState(3, 3)).toEqual({
      checked: true,
      indeterminate: false,
    });
  });

  it("is unchecked, not checked, on an empty table", () => {
    // 0 === 0 would otherwise read as "all selected" and offer a click that does nothing.
    expect(headerCheckState(0, 0)).toEqual({
      checked: false,
      indeterminate: false,
    });
  });
});
