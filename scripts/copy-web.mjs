#!/usr/bin/env node
// Copy the Next static export into dist/, where package.json `files: ["dist"]` publishes it and the
// UI server's default webRoot probe finds it.
//
// The rm before the copy is load-bearing: without it, stale content-hashed chunks accumulate and an
// index.html can reference a chunk that a later build renamed — the classic "works on my machine"
// failure. fs.cpSync rather than `cp -r` so win32 works.

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(repo, "web", "out");
const dest = join(repo, "dist", "front", "ui", "app");

if (!existsSync(src)) {
  console.error(`no static export at ${src} — run 'next build web' first`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`web bundle -> ${dest}`);
