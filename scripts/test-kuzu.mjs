#!/usr/bin/env node
// Runs the StoragePort conformance suite against the kuzu adapter IN THE MAIN
// PROCESS — no vitest, no fork, no IPC. kuzu's native binding cannot survive a
// vitest pool (fork IPC dies, threads segfault), and even sequential
// open→close→open cycles of kuzu Databases segfault (~3-4 cycles in). So:
// ONE database hosts the whole suite — safe because every case uses globally
// unique ids and distinctive search tokens — and the process exits WITHOUT
// closing: the verdict is recorded via process.exit before any native
// teardown can run. The temp dir is removed while handles are open (POSIX ok).
// Cases come from the same runner-neutral module the vitest wrapper uses
// (dist/ports/conformance-cases.js) — one contract source. Requires a prior
// `npm run build` (the npm script chains it).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformanceCases } from "../dist/ports/conformance-cases.js";
import { KuzuStorage } from "../dist/adapters/storage-kuzu/index.js";
import { seedOntology } from "../dist/core/ontology.js";

const scratch = mkdtempSync(join(tmpdir(), "yoke-kuzu-conf-"));
const port = new KuzuStorage(join(scratch, "db"));
await port.init();

let failed = 0;
for (const c of conformanceCases) {
  try {
    await c.run(port);
    console.log(`  ✓ ${c.name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${c.name}\n    ${e.message}`);
  }
}

// Ontology round-trip (the adapter-extension surface the CLI init path uses).
try {
  const seed = seedOntology();
  await port.saveOntology(seed);
  assert.deepStrictEqual(await port.loadOntology(), seed);
  console.log("  ✓ ontology save/load round-trips the seed");
} catch (e) {
  failed += 1;
  console.error(`  ✗ ontology save/load\n    ${e.message}`);
}

try {
  rmSync(scratch, { recursive: true, force: true });
} catch {
  // best-effort cleanup; the tmpdir reaper gets the rest.
}
const total = conformanceCases.length + 1;
console.log(`kuzu suite: ${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
