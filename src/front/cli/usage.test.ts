// Drift guard. docs/SPEC.md is the contract of record ("change this document first, then the
// code"), and its CLI block had drifted to omit nine shipped commands before anyone noticed —
// exactly the failure mode where an agent later "makes the code match SPEC" and deletes working
// features. One assertion is cheap enough to stay maintained; a doc-linting framework would not be.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

/** Command names from a `yoke ...` code block. `yoke a | b` and `yoke add / get` each list several
 * commands, but `<github-pr|slack|notes>` and `[--flag]` are argument groups — stripped first, or
 * their alternatives get read as commands. */
function commandsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^yoke\s+([^#]*)/.exec(line.trim());
    if (!m) continue;
    const bare = m[1].replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]/g, "");
    // Split on both separators. `yoke backup … / yoke restore …` repeats the binary name, so a
    // leading "yoke" is dropped; flags are not commands.
    for (const part of bare.split(/[|/]/)) {
      const first =
        part
          .trim()
          .replace(/^yoke\s+/, "")
          .split(/\s+/)[0] ?? "";
      if (/^[a-z][a-z-]*$/.test(first)) out.add(first);
    }
  }
  return out;
}

describe("CLI surface", () => {
  it("SPEC.md and usage() name the same commands", async () => {
    // Normalize line endings: git checks out CRLF on win32, and \r\n does not match \n.
    const spec = readFileSync("docs/SPEC.md", "utf8").replace(/\r\n/g, "\n");
    const block = /## CLI commands\n+```\n([\s\S]*?)```/.exec(spec);
    expect(block, "SPEC.md must have a fenced CLI commands block").toBeTruthy();
    const documented = commandsIn(block?.[1] ?? "");

    const printed: string[] = [];
    const restore = console.log;
    console.log = (m?: unknown) => printed.push(String(m));
    try {
      await runCli(["--help"]);
    } finally {
      console.log = restore;
    }
    const help = printed.join("\n");
    // usage() groups commands on `knowledge:`/`capture:`-style lines rather than `yoke ` lines.
    const listed = new Set(
      help
        .split("\n")
        .filter((l) =>
          /^(getting started|knowledge|capture|serving|data):/.test(l),
        )
        // Strip the parenthetical flag hints before splitting; a flag is not a command.
        .flatMap((l) =>
          l
            .replace(/^[a-z ]+:/, "")
            .replace(/\([^)]*\)/g, "")
            .split(","),
        )
        .map((s) =>
          s
            .trim()
            .split(/[\s|]+/)[0]
            .replace(/[^a-z-]/g, ""),
        )
        .filter((s) => /^[a-z][a-z-]*$/.test(s)),
    );
    // The indented "getting started" lines: `add <type> ...`, `review / verify <id...>`.
    for (const l of help.split("\n")) {
      const m = /^ {2}([a-z-]+(?:\s*\/\s*[a-z-]+)*)/.exec(l);
      if (m) for (const name of m[1].split("/")) listed.add(name.trim());
    }

    // Non-vacuity: two empty sets would satisfy the comparison below and guard nothing.
    for (const known of ["init", "add", "inject", "list", "graph", "serve"]) {
      expect(documented.has(known), `SPEC parse lost ${known}`).toBe(true);
      expect(listed.has(known), `usage() parse lost ${known}`).toBe(true);
    }

    const missingFromHelp = [...documented].filter((c) => !listed.has(c));
    const missingFromSpec = [...listed].filter((c) => !documented.has(c));
    expect(
      missingFromHelp,
      "documented in SPEC but absent from usage()",
    ).toEqual([]);
    expect(missingFromSpec, "in usage() but undocumented in SPEC").toEqual([]);
  });

  // The same drift guard, one clause deeper. SPEC said gate stage 3 fell back to FTS for duplicate
  // detection from v1 and the code never did — `commit.ts` skips on purpose, because treating every
  // FTS candidate as a duplicate is mostly false positives. The contract described an intention, and
  // the danger of that is the reverse direction: someone later "makes the code match SPEC" and builds
  // the fallback the code deliberately refused.
  it("SPEC does not promise an FTS fallback for duplicate detection", () => {
    const spec = readFileSync("docs/SPEC.md", "utf8").replace(/\r\n/g, "\n");
    const gate = /## Commit gate[\s\S]*?\n## /.exec(spec)?.[0] ?? "";
    // Non-vacuity: the section has to have been found and has to be about stage 3.
    expect(gate).toContain("Similar-entity lookup");
    expect(gate).not.toMatch(/otherwise FTS/i);
    // And it must state what actually happens instead, so the correction is not just a deletion.
    expect(gate).toMatch(/skipped/i);
  });
});
