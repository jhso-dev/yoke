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
 * Gzipped, because that is what the browser downloads — an uncompressed figure would be a number
 * nobody experiences. HTML is excluded: static export emits one file per route, so counting them
 * would make the budget grow with the number of screens rather than with what is shipped to run them.
 *
 * 400, raised from 380 when the accessibility and consistency pass landed and measured 379 — one
 * kilobyte of headroom is not a budget, it is a tripwire that fires on the next honest change. What
 * the eight kilobytes bought, since a budget rise has to name its purchase: Radix Select on the
 * token form (a free-text scope field became a picker, so a typo can no longer mint a token that
 * grants nothing), Radix Dialog on two more screens (a revoke now asks first, and a secret is shown
 * in something a reader must dismiss), Checkbox on the create form (a boolean attribute became a
 * control instead of the string "true"), and Separator. The routes that grew are the ones that
 * stopped being wrong.
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
 * Images have their own budget, because for a while they had none and the largest thing this app
 * shipped was the one thing not measured: the two home-page hero PNGs were 475 KB together —
 * more than the entire JS+CSS budget — both preloaded at high priority on every visit, and one of
 * them always hidden by the theme. A single number covering both would let a 40 KB script hide
 * inside an image regression, and vice versa.
 */
const IMAGE_BUDGET_KB = 120;

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
