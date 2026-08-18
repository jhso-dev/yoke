#!/usr/bin/env node
// `npm run bench` — the four arms of the README table, one command, rig pinned.
//
// The reason this is a script and not a block of shell in the README: an unpinned rig fails quietly.
// A reader model sampling at its server's default temperature moved single runs by 4-5 questions out
// of 42, which is larger than most effects worth measuring, and every comparison made against those
// numbers was noise wearing a decimal point. So this refuses to run until the harness carries the
// patches that pin it, naming each one — a preflight is cheaper than a re-measurement.
//
// It runs the arms sequentially on purpose: two runs against one local endpoint reproduce the
// concurrency stall documented in README.md, and the vanilla arm takes its concurrency from
// SDE_CONCURRENCY rather than from a flag.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AMB = process.env.AMB_DIR;
const UNITS = process.env.YOKE_BENCH_UNITS;
// qdrant's 22.8k-token injection does not finish inside the default 180s through a local small model,
// and a rival losing on our timeout is not a measurement.
const ARMS = ["vanilla", "fullcontext", "bm25", "qdrant", "yoke"];

/**
 * Harness edits this run depends on. Each is env-gated or additive upstream, so none changes what is
 * asked or how it is scored — but a missing one fails silently, which is why they are checked and not
 * merely documented. `needle` is grepped in `file`; absent means refuse.
 */
const PATCHES = [
  {
    file: "src/memory_bench/memory/__init__.py",
    needle: "yoke",
    fix: 'register the providers: REGISTRY["yoke"] = YokeMemoryProvider and REGISTRY["fullcontext"] = FullContextMemoryProvider (see bench/README.md "Setup")',
  },
  {
    file: "src/memory_bench/llm/openai.py",
    needle: "temperature",
    fix: "send temperature=0 and a fixed seed on the openai path — without it the server samples at its own default (~0.7 on LM Studio) and one arm moves +-4 questions between identical runs",
  },
  {
    file: "src/memory_bench/llm/openai.py",
    needle: "OMB_MAX_TOKENS",
    fix: "honour OMB_MAX_TOKENS and OMB_TOLERATE_BAD_JSON — uncapped, a small model can hang forever on one query; capped too low, truncated JSON raises and discards every query already scored",
  },
  {
    file: "src/memory_bench/runner.py",
    needle: "split(\",\")",
    fix: 'make --unit comma-separated: wanted = {u.strip() for u in str(unit).split(",") if u.strip()} — one unit is ~19 questions, which cannot rank two arms',
  },
];

/** Settings that must hold for the run to be comparable to the committed results. */
const PINNED = {
  SDE_CONCURRENCY: "1",
  YOKE_EXTRACT_CONCURRENCY: "1",
  OMB_TOLERATE_BAD_JSON: "1",
  OMB_MAX_TOKENS: process.env.OMB_MAX_TOKENS ?? "1200",
  OMB_TIMEOUT: process.env.OMB_TIMEOUT ?? "900",
};

const REQUIRED_ENV = [
  ["AMB_DIR", "path to a vectorize-io/agent-memory-benchmark clone"],
  ["YOKE_BENCH_UNITS", "comma-separated PersonaMem user ids — the units decide n, so state them"],
  ["YOKE_LLM_URL", "yoke's extractor endpoint (API root)"],
  ["YOKE_LLM_MODEL", "yoke's extractor model id"],
  ["OPENAI_BASE_URL", "the answering/judging endpoint the OpenAI SDK reads"],
  ["OMB_ANSWER_MODEL", "answering model id, exactly as /v1/models reports it"],
  ["OMB_JUDGE_MODEL", "judging model id"],
];

function refuse(lines) {
  console.error(`bench: not run.\n\n${lines.join("\n")}\n\nSetup in full: bench/README.md`);
  process.exitCode = 1;
}

function preflight() {
  const missing = REQUIRED_ENV.filter(([k]) => !process.env[k]).map(([k, why]) => `  ${k} — ${why}`);
  if (missing.length) return [`Set these first:`, ...missing];
  if (!existsSync(AMB)) return [`AMB_DIR does not exist: ${AMB}`];
  const unpatched = PATCHES.filter(({ file, needle }) => {
    const p = join(AMB, file);
    return !existsSync(p) || !readFileSync(p, "utf8").includes(needle);
  }).map(({ file, fix }) => `  ${file}: ${fix}`);
  if (unpatched.length)
    return [
      "The harness is not pinned for a comparable run. Apply these, then re-run:",
      ...unpatched,
    ];
  return null;
}

function runArm(arm) {
  const args = [
    "run",
    "amb",
    "run",
    "--dataset",
    "personamem",
    "--split",
    "32k",
    "--llm",
    "openai",
    "--unit",
    UNITS,
    "-m",
    arm,
    "-n",
    arm,
  ];
  console.log(`\n=== ${arm} ===`);
  execFileSync("uv", args, {
    cwd: AMB,
    stdio: "inherit",
    env: { ...process.env, ...PINNED, OMB_ANSWER_LLM: "openai", OMB_JUDGE_LLM: "openai" },
  });
}

/**
 * The harness writes results under its own directory; keep the ones THIS run produced.
 *
 * `seen` is why. The harness appends, so matching on the arm name alone re-collected every previous run's
 * files, and rescore then pooled two rigs into one row — n=84 for a 42-question unit, silently averaged.
 * That is the exact failure this script's closing note asks the reader to watch for, hidden by the script
 * itself. Recorded before the first arm runs, so anything not in it is new.
 */
function collect(arm, stamp, seen) {
  const dir = join(AMB, "results");
  if (!existsSync(dir)) return [];
  const kept = [];
  for (const f of readdirSync(dir).filter(
    (f) => f.includes(arm) && f.endsWith(".json") && !seen.has(f),
  )) {
    seen.add(f);
    const dest = `bench/results-${arm}-${stamp}-${f}`;
    copyFileSync(join(dir, f), dest);
    kept.push(dest);
  }
  return kept;
}

const problem = preflight();
if (problem) {
  refuse(problem);
} else {
  // Passed in rather than read from the clock: a stamp belongs to the run, and the caller may be
  // re-recording an older one.
  const stamp = process.env.YOKE_BENCH_STAMP ?? new Date().toISOString().slice(0, 10);
  console.log(
    `arms: ${ARMS.join(", ")}\nunits: ${UNITS}\npinned: ${Object.entries(PINNED)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  const produced = [];
  // Everything already in the harness's results dir belongs to an earlier run.
  const resultsDir = join(AMB, "results");
  const preexisting = new Set(
    existsSync(resultsDir) ? readdirSync(resultsDir) : [],
  );
  for (const arm of ARMS) {
    runArm(arm);
    produced.push(...collect(arm, stamp, preexisting));
  }
  if (produced.length === 0)
    console.error(
      "\nbench: the harness produced no new result files — nothing was scored.",
    );
  console.log("\nScored two ways — the harness's own number, and re-scored:");
  execFileSync("node", ["bench/rescore.mjs", ...produced], { stdio: "inherit" });
  console.log(
    "\nRead the vanilla row from the re-scored column: the harness marks an empty-context arm\n" +
      "wrong whatever it answered. Two runs of this command must agree question-for-question;\n" +
      "if they do not, the rig is not pinned and no comparison here is valid.",
  );
}
