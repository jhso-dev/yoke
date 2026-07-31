import { describe, expect, it } from "vitest";
import { chooseLocale } from ".";

describe("default locale", () => {
  it("defaults to English unless the browser has a stored choice", () => {
    expect(chooseLocale(null)).toBe("en");
    expect(chooseLocale("ko-KR")).toBe("en");
    expect(chooseLocale("ko")).toBe("ko");
  });
});
