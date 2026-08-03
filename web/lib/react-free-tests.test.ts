// A source guard: these tests run without web/node_modules, so none of them may reach React.
//
// The root vitest suite picks up `web/**/*.test.ts`, but the root `npm ci` installs only the root
// tree. `web/`'s own install happens as a side effect of `npm run typecheck` (which runs
// `typecheck:web` → `npm --prefix web install`), so on ubuntu the dependency is there by accident of
// ordering. The windows CI job runs `npm ci` then `test:main` with no typecheck between — and that
// is where it bit: `default.test.ts` imported `chooseLocale` from the i18n barrel, `index.tsx` is
// JSX, and win32 failed with `Cannot find package 'react/jsx-dev-runtime'` while every local run and
// both ubuntu jobs stayed green. Main sat red across two merges before anyone read the log.
//
// The rule that closes it: a test in this tree may not import a `.tsx` module, directly or via a
// barrel that re-exports one. Anything a test needs to check belongs in a `.ts` file — which is true
// on its own merits, since pure logic has no business living next to a provider.
//
// This is a static import check, not a resolution check: it reads the import specifiers rather than
// following them. A `.ts` module that itself imports React would slip past — but that has never
// happened here, and the runtime failure it would cause is the same one this file's message names.
// ponytail: specifier-level scan; walk the import graph if a `.ts` shim ever hides a React import.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tests(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "out") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tests(p));
    else if (/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every relative specifier a file imports from, `from "…"` and bare `import "…"` alike. */
function importsOf(src: string): string[] {
  return [...src.matchAll(/from\s+"(\.[^"]*)"|^\s*import\s+"(\.[^"]*)"/gm)].map(
    (m) => m[1] ?? m[2],
  );
}

/** What a specifier actually resolves to on disk, so a barrel's `.tsx` is not mistaken for `.ts`. */
function resolved(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec);
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

describe("web tests stay react-free", () => {
  const files = tests(webRoot);

  it("finds the web tests at all", () => {
    // Without this the suite below passes vacuously the day the glob or the layout changes.
    expect(files.length).toBeGreaterThan(5);
  });

  it("imports no .tsx module, because React is not installed when these run", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const spec of importsOf(src)) {
        const target = resolved(file, spec);
        if (target?.endsWith(".tsx")) {
          offenders.push(
            `${file.slice(webRoot.length + 1)} imports "${spec}" -> ${target.slice(webRoot.length + 1)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("resolves a barrel to its .tsx file, so the check above is not blind", () => {
    // i18n/index.tsx is the exact shape that broke win32: a JSX barrel re-exporting pure functions.
    const barrel = resolved(
      join(webRoot, "lib", "i18n", "default.test.ts"),
      ".",
    );
    expect(barrel?.endsWith("index.tsx")).toBe(true);
  });
});
