// banner() must be null on non-TTY / NO_COLOR so piped and --json output is
// never polluted with escape codes.

import { afterEach, describe, expect, it } from "vitest";
import { banner } from "./banner.js";

const origTty = process.stdout.isTTY;
const origNoColor = process.env.NO_COLOR;

afterEach(() => {
  process.stdout.isTTY = origTty;
  if (origNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = origNoColor;
});

describe("banner", () => {
  it("returns null when stdout is not a TTY", () => {
    process.stdout.isTTY = false;
    delete process.env.NO_COLOR;
    expect(banner()).toBeNull();
  });

  it("returns null when NO_COLOR is set, even on a TTY", () => {
    process.stdout.isTTY = true;
    process.env.NO_COLOR = "";
    expect(banner()).toBeNull();
  });

  it("returns a coloured wordmark on a TTY with NO_COLOR unset", () => {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    const out = banner();
    expect(out).toContain("\x1b[38;2;"); // true-color gradient
    expect(out).toContain("knowledge your AI can trust");
  });
});
