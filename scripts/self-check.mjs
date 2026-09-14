#!/usr/bin/env node
// Weekly self-check: read the loop's own numbers, compare them to last week's, and say what moved
// the wrong way. Proposes, never decides — it files a finding and stops.
//
// The ratio `audit --roi` ends in is deliberately NOT a target: maximizing it rewards delivering more
// (propagation scales with deliveries), routing filing through connectors (drops the cost term,
// touches nothing real), and not weeding (re-confirmations ARE the cost, so a rotting corpus reads as
// efficiency). The five terms below are the ones no assumption enters and no volume improves, and each
// fires on a WORSENING against the team's own previous week rather than an invented number.
//
// Schedule it however the machine schedules things — a launchd agent on a laptop, cron on a box:
//   node scripts/self-check.mjs --db <store> --baseline ~/.yoke-team/baseline.json --issue
// The first run has nothing to compare against: it writes the baseline and exits 0.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

/** A tripwire fires when a measured term got worse than the team's own last reading. */
export function evaluate(prev, now) {
  const pct = (n) => `${Math.round(n * 1000) / 10}%`;
  const min = (n) => `${Math.round(n * 10) / 10} min`;
  const checks = [
    {
      name: "hands-free capture",
      // A drop means people went back to typing knowledge in by hand, which is the cost term that
      // dominates every reading so far (92% of spend on the rig's first week).
      worse: now.handsFree < prev.handsFree - 0.1,
      says: `${pct(prev.handsFree)} → ${pct(now.handsFree)}`,
    },
    {
      name: "decision delivery lag",
      // Volume cannot improve this, which is why it is here: a team that floods the scope moves the
      // ratio up and this number not at all.
      worse: now.lagHours > Math.max(1, prev.lagHours * 2),
      says: `${Math.round(prev.lagHours * 10) / 10}h → ${Math.round(now.lagHours * 10) / 10}h median`,
    },
    {
      name: "arriving while still news",
      worse: now.inWindow < prev.inWindow - 0.15,
      says: `${pct(prev.inWindow)} → ${pct(now.inWindow)} of decision deliveries`,
    },
    {
      name: "attention per decision delivered",
      // Noise creeping into briefings shows up here first: the same decisions cost more to receive.
      worse: now.attentionPerDecision > prev.attentionPerDecision * 1.5,
      says: `${min(prev.attentionPerDecision)} → ${min(now.attentionPerDecision)}`,
    },
    {
      name: "re-confirmation queue",
      // Not weeding is the cheapest way to look efficient, so the queue growing is a tripwire even
      // though every other number improves when it is ignored.
      worse: now.staleQueue > Math.max(5, prev.staleQueue * 2),
      says: `${prev.staleQueue} → ${now.staleQueue} records past their window`,
    },
  ];
  return checks.filter((c) => c.worse);
}

function read(db) {
  const run = (args) =>
    JSON.parse(
      execFileSync(
        "node",
        [
          new URL("../dist/front/cli/index.js", import.meta.url).pathname,
          ...args,
          "--db",
          db,
          "--json",
        ],
        { encoding: "utf8", env: { ...process.env, YOKE_NO_AUTO_EMBED: "1" } },
      ),
    );
  const pulse = run(["audit", "--pulse"]);
  const roi = run(["audit", "--roi"]);
  const stale = run(["review"]);
  const judgeable = pulse.capture.scanned - pulse.capture.unjudged;
  return {
    at: new Date().toISOString(),
    handsFree:
      judgeable === 0
        ? 0
        : (pulse.capture.agent + pulse.capture.connector) / judgeable,
    lagHours: roi.measured.lagHours,
    inWindow:
      roi.measured.deliveriesTimed === 0
        ? 0
        : roi.measured.deliveriesInWindow / roi.measured.deliveriesTimed,
    attentionPerDecision:
      roi.measured.deliveriesTimed === 0
        ? 0
        : roi.spent.attention / roi.measured.deliveriesTimed,
    staleQueue: Array.isArray(stale) ? stale.length : 0,
    // Carried for the report, never for a tripwire: it rests on assumptions (RESEARCH §7).
    efficiency: roi.efficiency,
    breakEvenHours: roi.breakEvenHours,
  };
}

function selftest() {
  const base = {
    handsFree: 0.75,
    lagHours: 2,
    inWindow: 0.6,
    attentionPerDecision: 0.02,
    staleQueue: 4,
  };
  const ok = (label, cond) => {
    if (!cond) throw new Error(`selftest: ${label}`);
  };
  ok("steady week trips nothing", evaluate(base, { ...base }).length === 0);
  ok(
    "hand-filing returning trips",
    evaluate(base, { ...base, handsFree: 0.5 }).length === 1,
  );
  ok(
    "slower delivery trips",
    evaluate(base, { ...base, lagHours: 9 }).length === 1,
  );
  ok(
    "late arrivals trip",
    evaluate(base, { ...base, inWindow: 0.3 }).length === 1,
  );
  ok(
    "fatter briefings trip",
    evaluate(base, { ...base, attentionPerDecision: 0.05 }).length === 1,
  );
  ok(
    "queue doubling trips",
    evaluate(base, { ...base, staleQueue: 20 }).length === 1,
  );
  // The shortcuts an optimizer would take must NOT read as improvements.
  ok(
    "flooding the scope trips nothing and rescues nothing",
    evaluate(base, { ...base, inWindow: 0.3, attentionPerDecision: 0.05 })
      .length === 2,
  );
  ok(
    "an improving week is silent",
    evaluate(base, { ...base, handsFree: 0.9, lagHours: 1 }).length === 0,
  );
  console.log("selftest: ok");
}

// Imported rather than run (a test, another script): export the rule and do nothing else.
if (import.meta.url !== pathToFileURL(process.argv[1] ?? "").href) {
  // nothing
} else if (has("selftest")) {
  selftest();
} else {
  main();
}

function main() {
  const db = flag("db", process.env.YOKE_DB);
  if (!db) {
    console.error(
      "usage: node scripts/self-check.mjs --db <store> [--baseline f.json] [--issue] [--selftest]",
    );
    process.exit(2);
  }
  const baselinePath = flag("baseline", null);
  const now = read(db);
  const prev =
    baselinePath && existsSync(baselinePath)
      ? JSON.parse(readFileSync(baselinePath, "utf8"))
      : null;

  const lines = [
    `yoke self-check ${now.at}`,
    `  hands-free capture            ${Math.round(now.handsFree * 1000) / 10}%`,
    `  decision delivery lag         ${Math.round(now.lagHours * 10) / 10}h median`,
    `  arriving while still news     ${Math.round(now.inWindow * 1000) / 10}%`,
    `  attention per decision        ${Math.round(now.attentionPerDecision * 1000) / 1000} min`,
    `  re-confirmation queue         ${now.staleQueue}`,
    `  efficiency (assumption-bound) ${now.efficiency === null ? "—" : `${Math.round(now.efficiency * 10) / 10}x`}`,
  ];
  const tripped = prev ? evaluate(prev, now) : [];
  // The one shortcut the trail cannot see: junk routed in through a connector costs nobody a keystroke
  // and leaves every measured term fine until the noise reaches a briefing. `npm run eval` exits
  // non-zero on a contamination or gold-in-brief regression, so capturing more by capturing worse
  // cannot read as a good week. Needs a checkout, so only a job on a machine with the repo passes it.
  if (has("eval")) {
    try {
      execFileSync("npm", ["run", "--silent", "eval"], {
        cwd: new URL("..", import.meta.url).pathname,
        stdio: "pipe",
        env: { ...process.env, YOKE_NO_AUTO_EMBED: "1" },
      });
    } catch {
      tripped.push({
        name: "injection quality gate",
        says: "`npm run eval` failed — contamination or gold-in-brief regressed",
      });
    }
  }
  if (!prev)
    lines.push(
      "  (first run — baseline written, nothing to compare against yet)",
    );
  else if (tripped.length === 0)
    lines.push(`  nothing worsened against ${prev.at}`);
  else for (const t of tripped) lines.push(`  WORSE: ${t.name} — ${t.says}`);
  const report = lines.join("\n");
  console.log(report);

  if (baselinePath)
    writeFileSync(baselinePath, JSON.stringify(now, null, 2) + "\n");

  // Filing the finding, when asked. One open issue per marker: a weekly job that opens a new issue
  // every week is a job nobody reads after a month, so a standing one gets a comment instead.
  if (has("issue") && tripped.length > 0) {
    const MARK = "[self-check]";
    const title = `${MARK} ${tripped.map((t) => t.name).join(", ")} worsened`;
    const body = `${report}\n\nProposed, not decided: these are measured terms only (docs/RESEARCH.md §7 says why the ratio is never the target). Someone reads this and decides whether anything should change.`;
    const open = JSON.parse(
      execFileSync(
        "gh",
        [
          "issue",
          "list",
          "--search",
          MARK,
          "--state",
          "open",
          "--json",
          "number,title",
        ],
        {
          encoding: "utf8",
        },
      ) || "[]",
    );
    if (open.length > 0)
      execFileSync(
        "gh",
        ["issue", "comment", String(open[0].number), "--body", body],
        { stdio: "inherit" },
      );
    else
      execFileSync(
        "gh",
        ["issue", "create", "--title", title, "--body", body],
        { stdio: "inherit" },
      );
  }
  process.exit(tripped.length > 0 ? 1 : 0);
}
