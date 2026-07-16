// TTY-only decoration for the CLI. Pure ANSI, no dependencies.
// Every function here is a no-op / null on non-TTY or when NO_COLOR is set, so
// piped and --json output stays byte-identical to the undecorated path.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// package.json sits at the package root in both source (../../../ from src/front/cli)
// and published layouts (../../../ from dist/front/cli) — npm always ships it.
const { version } = require("../../../package.json") as { version: string };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

// "YOKE" wordmark in ANSI-Shadow style (solid faces, double-line shadow edges),
// coloured with a teal → indigo vertical gradient (deliberately not Hermes gold).
const WORDMARK = [
  "██╗   ██╗ ██████╗ ██╗  ██╗███████╗",
  "╚██╗ ██╔╝██╔═══██╗██║ ██╔╝██╔════╝",
  " ╚████╔╝ ██║   ██║█████╔╝ █████╗  ",
  "  ╚██╔╝  ██║   ██║██╔═██╗ ██╔══╝  ",
  "   ██║   ╚██████╔╝██║  ██╗███████╗",
  "   ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝",
];
const GRADIENT = [
  "#2dd4bf",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
];

const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};

/** True when decorated output is allowed: an interactive stdout and NO_COLOR unset. */
export function decorated(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

/** The gradient wordmark + dim tagline/version, or null when decoration is off. */
export function banner(): string | null {
  if (!decorated()) return null;
  const lines = WORDMARK.map(
    (row, i) => `${BOLD}\x1b[38;2;${rgb(GRADIENT[i])}m${row}${RESET}`,
  );
  lines.push(`${DIM}   knowledge your AI can trust · v${version}${RESET}`);
  return lines.join("\n");
}

// Log-line formatters (return strings; the caller decides when to print them).
export const log = {
  info: (s: string): string => `${CYAN}→${RESET} ${s}`,
  ok: (s: string): string => `${GREEN}✓${RESET} ${s}`,
  warn: (s: string): string => `${YELLOW}⚠${RESET} ${s}`,
  err: (s: string): string => `${RED}✗${RESET} ${s}`,
};

/** Boxed "get started" block shown after a fresh init. */
export function getStartedBlock(): string {
  const bar = "─".repeat(46);
  const row = (cmd: string, desc: string): string =>
    `${CYAN}│${RESET} ${cmd.padEnd(24)}${DIM}${desc}${RESET}`;
  return [
    `${CYAN}┌ get started ${bar.slice(13)}${RESET}`,
    row("yoke add fact --attr …", "stage knowledge as a draft"),
    row("yoke review", "inspect the draft queue"),
    row("yoke verify <id>", "promote to verified"),
    row('yoke inject "<query>"', "retrieve with citations"),
    `${CYAN}│${RESET} ${DIM}attach to your agent via .mcp.json — see the README${RESET}`,
    `${CYAN}└${bar}${RESET}`,
  ].join("\n");
}
