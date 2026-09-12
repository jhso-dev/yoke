// The budget test PLAN-V2 said existed.
//
// The document has recorded a shipped-bundle budget since v5.0 was planned, "asserted by a test that
// stats the build output" — and no such test was ever written. The line-count budget beside it drifted
// from 1,500 to 2,893 unnoticed for exactly that reason, and the correction note there says the two
// budgets a build actually measures had held. One of them was not being measured either.
//
// Skips when there is no build, because CI runs tests before build and no test may require one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const bundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../dist/front/ui/app",
);
const built = existsSync(join(bundle, "index.html"));

/**
 * Gzipped, because that is what the browser downloads. HTML is excluded: static export emits one file
 * per route, so counting them would make the budget grow with the number of screens rather than with
 * what is shipped to run them.
 *
 * A budget rise has to name its purchase, and has to leave more than a kilobyte of headroom — less
 * than that is a tripwire that fires on the next honest change, not a budget.
 */
const BUDGET_KB = 400;

function transferBytes(dir: string, pattern: RegExp): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) total += transferBytes(p, pattern);
    else if (pattern.test(name)) total += gzipSync(readFileSync(p)).length;
  }
  return total;
}

/**
 * Images have their own budget: the JS+CSS figure above filters on `.js|.css`, so the home page's two
 * hero PNGs — 460 KB gzipped between them, both preloaded at high priority, one always hidden by the
 * active theme — count toward nothing there. One number covering both kinds would let a script
 * regression hide inside an image, and the reverse.
 *
 * Set ABOVE what those two cost, deliberately: they are the artwork as authored, and recompressing
 * someone's art to buy back bandwidth is their call, not this test's. So this is a tripwire for a NEW
 * unmeasured asset, not a verdict on these two — if they are ever optimised, lower it in the same
 * commit. A budget left loose after the thing it was loose for is gone is an unenforced comment.
 */
const IMAGE_BUDGET_KB = 500;

describe.skipIf(!built)("shipped bundle size", () => {
  it(`stays under ${BUDGET_KB} KB gzipped`, () => {
    const kb = Math.round(transferBytes(bundle, /\.(js|css)$/) / 1024);
    // Reported on every run, pass or fail: a budget you only hear about when it breaks tells you
    // nothing about the direction you are heading in.
    console.log(`shipped JS+CSS: ${kb} KB gzipped (budget ${BUDGET_KB} KB)`);
    expect(kb).toBeLessThanOrEqual(BUDGET_KB);
  });

  it(`ships under ${IMAGE_BUDGET_KB} KB of images`, () => {
    const kb = Math.round(
      transferBytes(bundle, /\.(png|jpe?g|gif|webp|avif|svg)$/i) / 1024,
    );
    console.log(
      `shipped images: ${kb} KB gzipped (budget ${IMAGE_BUDGET_KB} KB)`,
    );
    expect(kb).toBeLessThanOrEqual(IMAGE_BUDGET_KB);
  });
});
