import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every non-test source file under `dir`, recursively, whose name matches `ext`.
 *
 * The three guard tests in this directory — dead i18n keys, raw-id rendering, button casing — each
 * work by reading the source tree, and each had its own copy of this walk. Three copies of a "which
 * files count as source" rule is three definitions of it, and a guard that silently stops covering a
 * directory is worse than no guard because it still reports green.
 *
 * `ext` is a real difference between the callers rather than a knob for later: the button-casing guard
 * reads only `.tsx`, because a button label lives in a component, and widening it to `.ts` would change
 * what that test asserts.
 */
export function sources(dir: string, ext = /\.tsx?$/): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p, ext));
    else if (ext.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}
