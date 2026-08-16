// identitySet tests — the `same_as` closure, exercised directly rather than through persona.
//
// Through persona these would be vacuous: inject re-filters candidates by namespace, so a
// cross-tenant id in the set is dropped one layer down and the leak never shows. The set's own
// contract is what other consumers will rely on, so it is asserted where it lives.

import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/storage-sqlite/index.js";
import { commit } from "./commit.js";
import { identitySet } from "./identity.js";
import { seedOntology } from "./ontology.js";

const ont = seedOntology();
const now = "2026-07-12T00:00:00Z";
const prov = { actor: "admin", origin: "cli", occurred_at: now };

let port: SqliteStorage;
beforeEach(async () => {
  port = new SqliteStorage(":memory:");
  await port.init();
});

/**
 * A person record for each endpoint — the gate rejects an edge to an id that is not a record.
 * Idempotent, because these ids are linked into chains and re-putting (id, version) conflicts.
 */
async function node(id: string, ns?: string) {
  if (await port.getEntity(id)) return;
  await port.putEntity({
    id,
    type: "person",
    attributes: { name: id },
    status: "verified",
    version: 1,
    last_confirmed: now,
    provenance: prov,
    ...(ns ? { ns } : {}),
  });
}

/** alias --same_as--> canonical, through the ordinary gate: the link is knowledge, not config. */
async function link(from: string, to: string, ns?: string) {
  await node(from, ns);
  await node(to, ns);
  await commit(
    port,
    ont,
    { type: "same_as", attributes: {}, from, to },
    prov,
    now,
    ns ? { ns } : undefined,
  );
}

describe("identitySet", () => {
  it("is just the id when nothing says otherwise", async () => {
    expect(await identitySet(port, "solo")).toEqual(["solo"]);
  });

  it("follows same_as in both directions and transitively", async () => {
    await link("git", "hr"); // hr is canonical
    await link("slack", "hr");
    // Asked from any of the three, the answer is the same person. A resolver that honoured the
    // arrow's direction would answer "hr" from git and "git, slack, hr" from hr.
    for (const anchor of ["hr", "git", "slack"]) {
      expect((await identitySet(port, anchor)).slice().sort()).toEqual([
        "git",
        "hr",
        "slack",
      ]);
    }
  });

  it("puts the queried record first and is otherwise stable", async () => {
    await link("zed", "abe");
    await link("mid", "abe");
    // Breadth-first from the query, each frontier sorted — `neighbors` promises no order, so without
    // the sort two backends would generate two different SKILL.md files from one corpus.
    expect(await identitySet(port, "abe")).toEqual(["abe", "mid", "zed"]);
    expect(await identitySet(port, "zed")).toEqual(["zed", "abe", "mid"]);
  });

  it("terminates on a cycle", async () => {
    await link("a", "b");
    await link("b", "c");
    await link("c", "a"); // the visited set is the only thing between this and a hang
    expect((await identitySet(port, "b")).slice().sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not cross a namespace", async () => {
    // `neighbors` takes no ns filter, so this belongs in core — the same hole the vector half of
    // hybrid retrieval had. Without it, a link filed by one tenant renames a person for another.
    await link("mine", "theirs", "acme");
    expect(await identitySet(port, "mine")).toEqual(["mine"]);
    expect((await identitySet(port, "mine", "acme")).slice().sort()).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("does not follow an edge to a person in another namespace", async () => {
    // The edge's own ns was the only thing checked, and an edge carries its own namespace while its
    // ENDPOINTS carry theirs: a `same_as` filed here naming another tenant's person put that tenant's
    // entity id in the union, which the exported persona prints under "Identity union". No knowledge
    // crossed (inject re-filters candidates), and the identity did.
    await node("local");
    await node("foreign", "acme");
    await commit(
      port,
      ont,
      { type: "same_as", attributes: {}, from: "local", to: "foreign" },
      prov,
      now,
    );
    expect(await identitySet(port, "local")).toEqual(["local"]);
  });

  it("drops an endpoint that resolves to no record at all", async () => {
    // A dangling endpoint is not a record of this person in this namespace, which is the question the
    // set answers. It reaches the same read as the ns filter, so it costs nothing extra.
    await node("here");
    await port.putRelation({
      id: "01DANGLING",
      type: "same_as",
      from: "here",
      to: "01NOSUCHRECORD",
      attributes: {},
      status: "draft",
      version: 1,
      last_confirmed: now,
      provenance: prov,
    });
    expect(await identitySet(port, "here")).toEqual(["here"]);
  });
});
