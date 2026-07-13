// storage-kuzu tests — run the conformance suite against a fresh on-disk kuzu database per case
// (kuzu has no :memory: parity, so each make() gets its own scratch temp dir), plus an ontology
// save/load round-trip.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { seedOntology } from "../../core/ontology.js";
import { describeStoragePort } from "../../ports/conformance.js";
import { KuzuStorage } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-kuzu-"));
const freshPath = () => join(dir, `db-${Math.random().toString(36).slice(2)}`);

describeStoragePort(
  "kuzu (temp dir)",
  async () => new KuzuStorage(freshPath()),
);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ontology save/load", () => {
  it("round-trips the seed ontology", async () => {
    const store = new KuzuStorage(freshPath());
    await store.init();
    const seed = seedOntology();
    await store.saveOntology(seed);
    expect(await store.loadOntology()).toEqual(seed);
    store.close();
  });
});
