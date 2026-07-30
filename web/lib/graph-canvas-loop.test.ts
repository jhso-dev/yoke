// A source guard: a stuck drag (no pointercancel handler) or a selection-dep rebuild (`selected` in
// the main effect's dependency array) both pin a core at 60fps — see GraphCanvas.tsx. This greps for
// the two shapes that caused it rather than rendering a canvas + simulating pointer capture loss.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../components/GraphCanvas.tsx",
  ),
  "utf8",
);

describe("GraphCanvas rAF loop does not run forever", () => {
  it("handles pointercancel, not just pointerup", () => {
    expect(src).toContain('"pointercancel"');
  });

  it("does not rebuild the simulation when `selected` changes", () => {
    // `selected` may only ever appear alone in a dep array (the small redraw-only effect) — combined
    // with anything else (`[graph, ..., selected, ...]`) is the main effect rebuilding the whole
    // simulation, and reheating it, on every click.
    const depArrays = [...src.matchAll(/\}, \[([^\]]*)\]\)/g)].map((m) => m[1]);
    const rebuildsOnSelected = depArrays.some(
      (deps) => deps.includes("selected") && deps.trim() !== "selected",
    );
    expect(rebuildsOnSelected).toBe(false);
  });
});
