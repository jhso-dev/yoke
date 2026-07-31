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
 */
const BUDGET_KB = 380;

function transferBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) total += transferBytes(p);
    else if (/\.(js|css)$/.test(name))
      total += gzipSync(readFileSync(p)).length;
  }
  return total;
}

describe.skipIf(!built)("shipped bundle size", () => {
  it(`stays under ${BUDGET_KB} KB gzipped`, () => {
    const kb = Math.round(transferBytes(bundle) / 1024);
    // Reported on every run, pass or fail: a budget you only hear about when it breaks tells you
    // nothing about the direction you are heading in.
    console.log(`shipped JS+CSS: ${kb} KB gzipped (budget ${BUDGET_KB} KB)`);
    expect(kb).toBeLessThanOrEqual(BUDGET_KB);
  });
});
