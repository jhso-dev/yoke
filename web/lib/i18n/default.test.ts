import { describe, expect, it } from "vitest";
// From "./locale", NOT "." — index.tsx is JSX, and this suite runs without web/node_modules on
// windows CI (see the note in locale.ts). Importing the barrel here is what broke win32.
import { chooseLocale } from "./locale";

describe("default locale", () => {
  it("defaults to English unless the browser has a stored choice", () => {
    expect(chooseLocale(null)).toBe("en");
    expect(chooseLocale("ko-KR")).toBe("en");
    expect(chooseLocale("ko")).toBe("ko");
  });
});
