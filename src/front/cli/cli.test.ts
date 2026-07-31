// CLI scenario tests — call runCli directly (no process spawn needed; exit code is the return value).
// Uses a temp-directory DB for one init→add→get→search round-trip plus one rejected add (exit 1).

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStorage } from "../../adapters/storage-sqlite/index.js";
import { commit } from "../../core/commit.js";
import { seedOntology } from "../../core/ontology.js";
import type { Provenance } from "../../core/types.js";
import { runCli } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
    errs.push(String(m));
  });
});

function newDb(): string {
  return join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("runCli", () => {
  it("init → add → get → search round-trip", async () => {
    const db = newDb();

    expect(await runCli(["init", "--db", db])).toBe(0);

    // Idempotent re-run: does not re-seed.
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(logs.at(-1)).toContain("already initialized");

    // add (use --json to capture the id)
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=hello",
        "--json",
      ]),
    ).toBe(0);
    const added = JSON.parse(logs.at(-1) as string);
    expect(added.type).toBe("fact");
    expect(added.status).toBe("draft");
    expect(added.attributes.title).toBe("hello");

    // get
    expect(await runCli(["get", added.id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).id).toBe(added.id);

    // absent get → exit 1
    expect(await runCli(["get", "nope", "--db", db])).toBe(1);

    // search
    expect(await runCli(["search", "hello", "--db", db, "--json"])).toBe(0);
    const found = JSON.parse(logs.at(-1) as string);
    expect(found.some((e: { id: string }) => e.id === added.id)).toBe(true);
  });

  it("rejects invalid add with exit 1", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // decision requires conclusion/rationale → the gate rejects when they are missing.
    expect(await runCli(["add", "decision", "--db", db])).toBe(1);
    expect(errs.at(-1)).toContain("rejected");
  });

  it("add --scope creates a relates_to link to the scope entity (v4.0)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // a collaboration to scope to
    expect(
      await runCli([
        "add",
        "collaboration",
        "--db",
        db,
        "--attr",
        "title=cli scope ws",
        "--json",
      ]),
    ).toBe(0);
    const wsId = JSON.parse(logs.at(-1) as string).id as string;
    // a fact linked to it
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=scoped fact",
        "--scope",
        wsId,
        "--json",
      ]),
    ).toBe(0);
    const factId = JSON.parse(logs.at(-1) as string).id as string;
    // verify the link via neighbors
    const store = new SqliteStorage(db);
    await store.init();
    const rels = await store.neighbors(factId, "relates_to");
    store.close();
    expect(rels.some((r) => r.from === factId && r.to === wsId)).toBe(true);
  });

  it("lifecycle E2E: add(draft) → excluded from inject → review → verify → shown in inject → deprecate → excluded", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // add → draft
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=lifecycletoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;

    // a draft is excluded from inject by default
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);

    // --include-draft shows it
    expect(
      await runCli([
        "inject",
        "lifecycletoken",
        "--db",
        db,
        "--include-draft",
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(1);

    // the draft appears in review
    expect(await runCli(["review", "--db", db, "--json"])).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).some(
        (e: { id: string }) => e.id === id,
      ),
    ).toBe(true);

    // verify → promoted
    expect(await runCli(["verify", id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)[0].status).toBe("verified");

    // this fact disappears from review (the yoke:system draft may remain)
    expect(await runCli(["review", "--db", db, "--json"])).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).some(
        (e: { id: string }) => e.id === id,
      ),
    ).toBe(false);

    // verified → shown in the default inject (with citation)
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    const injected = JSON.parse(logs.at(-1) as string);
    expect(injected).toHaveLength(1);
    expect(injected[0].citation).toContain(id);

    // deprecate → disappears from inject
    expect(await runCli(["deprecate", id, "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)[0].status).toBe("deprecated");
    expect(
      await runCli(["inject", "lifecycletoken", "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toHaveLength(0);
  });

  it("verify --all-drafts promotes every draft", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    for (const t of ["alpha", "beta"]) {
      expect(
        await runCli(["add", "fact", "--db", db, "--attr", `title=${t}`]),
      ).toBe(0);
    }
    expect(await runCli(["verify", "--all-drafts", "--db", db, "--json"])).toBe(
      0,
    );
    // yoke:system person (draft) + 2 facts = 3 promoted
    expect(JSON.parse(logs.at(-1) as string).length).toBeGreaterThanOrEqual(2);
    expect(await runCli(["review", "--db", db])).toBe(0);
    expect(logs.at(-1)).toBe("no drafts");
  });

  it("conflicts lists conflicts_with pairs with both entities", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // Seed two conflicting decisions + a conflicts_with relation directly, through the gate.
    const ont = seedOntology();
    const now = "2026-07-12T00:00:00Z";
    const prov: Provenance = {
      actor: "yoke:system",
      origin: "cli",
      occurred_at: now,
    };
    const store = new SqliteStorage(db);
    await store.init();
    const a = await commit(
      store,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "use postgres", rationale: "r" },
      },
      prov,
      now,
    );
    const b = await commit(
      store,
      ont,
      {
        type: "decision",
        attributes: { conclusion: "use mysql", rationale: "r" },
      },
      prov,
      now,
    );
    await commit(
      store,
      ont,
      {
        type: "conflicts_with",
        attributes: {},
        from: b.entity.id,
        to: a.entity.id,
      },
      prov,
      now,
    );
    store.close();

    expect(await runCli(["conflicts", "--db", db, "--json"])).toBe(0);
    const out = JSON.parse(logs.at(-1) as string);
    expect(out).toHaveLength(1);
    expect(out[0].from.id).toBe(b.entity.id);
    expect(out[0].to.id).toBe(a.entity.id);

    // a fresh DB with no conflicts
    const db2 = newDb();
    expect(await runCli(["init", "--db", db2])).toBe(0);
    expect(await runCli(["conflicts", "--db", db2])).toBe(0);
    expect(logs.at(-1)).toBe("no conflicts");

    // The pair above lives in the default namespace, so a tenant must not see it — a global
    // listing that ignores ns hands one tenant another's decisions.
    expect(
      await runCli(["conflicts", "--db", db, "--ns", "acme", "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual([]);
  });

  it("persona writes SKILL.md for a person to --out dir", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    // Record a decision with yoke:system (person, verified) as actor, then promote it with the same actor.
    expect(
      await runCli([
        "add",
        "decision",
        "--db",
        db,
        "--actor",
        "yoke:system",
        "--attr",
        "conclusion=use SQLite",
        "--attr",
        "rationale=zero-config",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;
    expect(
      await runCli(["verify", id, "--db", db, "--actor", "yoke:system"]),
    ).toBe(0);

    expect(
      await runCli([
        "persona",
        "yoke:system",
        "--db",
        db,
        "--out",
        dir,
        "--json",
      ]),
    ).toBe(0);
    const { path, sources } = JSON.parse(logs.at(-1) as string);
    expect(path).toBe(join(dir, "persona-yoke-system", "SKILL.md"));
    expect(sources).toBeGreaterThanOrEqual(1);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("name: persona-yoke-system");
    expect(md).toContain("use SQLite");
    expect(md).toContain("Do not answer without a citation");

    // absent person → exit 1
    expect(await runCli(["persona", "nobody", "--db", db])).toBe(1);
  });

  it("backfill derives authorship edges for pre-upgrade knowledge, idempotently", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // A database written before authorship was a graph edge: same gate, but no authored_by type to
    // derive an edge from. The person anchor cannot see this knowledge yet.
    const store = new SqliteStorage(db);
    await store.init();
    const legacy = seedOntology().filter((t) => t.name !== "authored_by");
    const prov: Provenance = {
      actor: "alex",
      origin: "cli",
      occurred_at: "2026-07-01T00:00:00Z",
    };
    const { entity } = await commit(
      store,
      legacy,
      {
        type: "decision",
        attributes: { conclusion: "use kuzu", rationale: "graph" },
      },
      prov,
      "2026-07-01T00:00:00Z",
    );
    // The person record itself is current (committed with authored_by available), so it is already
    // linked and must not be counted again — it isolates the count to the one legacy entity.
    await commit(
      store,
      seedOntology(),
      { type: "person", attributes: { name: "Alex" } },
      { actor: "yoke:system", origin: "cli", occurred_at: prov.occurred_at },
      prov.occurred_at,
      { existingId: "alex" },
    );
    store.close();
    // Promoted by someone else — the latest row's provenance actor is now the promoter.
    expect(
      await runCli(["verify", entity.id, "--db", db, "--actor", "admin"]),
    ).toBe(0);

    expect(await runCli(["backfill", "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).created).toBe(1);

    // Credited to the author in the history, not to the promoter of the latest version.
    expect(
      await runCli(["persona", "alex", "--db", db, "--out", dir, "--json"]),
    ).toBe(0);
    expect(
      readFileSync(join(dir, "persona-alex", "SKILL.md"), "utf8"),
    ).toContain("use kuzu");

    // Idempotent: nothing left to derive.
    expect(await runCli(["backfill", "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).created).toBe(0);
  });

  it("link records a relation — the roster a collaboration is named for", async () => {
    // `add <relation>` cannot do this: a relation needs endpoints and `add` has nowhere to put them,
    // so works_on had no creation path at all and every "people on this work" panel was empty.
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    const mk = async (type: string, attr: string) => {
      expect(
        await runCli(["add", type, "--attr", attr, "--db", db, "--json"]),
      ).toBe(0);
      return JSON.parse(logs.at(-1) as string).id as string;
    };
    const person = await mk("person", "name=Bora");
    const work = await mk("collaboration", "title=auth revamp");
    expect(await runCli(["link", person, "works_on", work, "--db", db])).toBe(
      0,
    );
    expect(
      await runCli(["get", work, "--relations", "--db", db, "--json"]),
    ).toBe(0);
    const rels = JSON.parse(logs.at(-1) as string) as {
      relations: { type: string; from: string; to: string }[];
    };
    // Direction matters: works_on points person → collaboration, which is why an anchor gathers a
    // roster rather than holding one. A link recorded the other way round would still "work" and
    // would put the collaboration on the person's briefing instead.
    expect(rels.relations).toContainEqual(
      expect.objectContaining({ type: "works_on", from: person, to: work }),
    );

    // The gate stays the only door: an undeclared relation type is refused here like anywhere else.
    expect(
      await runCli(["link", person, "invented_rel", work, "--db", db]),
    ).toBe(1);
    // And both endpoints are required — a half-link is not a relation.
    expect(await runCli(["link", person, "works_on", "--db", db])).toBe(1);
  });

  it("list / graph / get --relations / inject --scope give the web tier its CLI parity", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "collaboration",
        "--db",
        db,
        "--attr",
        "title=PAY-42",
        "--json",
      ]),
    ).toBe(0);
    const ws = JSON.parse(logs.at(-1) as string).id as string;
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "note=tokenizer swap",
        "--scope",
        ws,
        "--json",
      ]),
    ).toBe(0);
    const fact = JSON.parse(logs.at(-1) as string).id as string;
    expect(await runCli(["verify", "--all-drafts", "--db", db])).toBe(0);

    // list: enumerate, filter, and page.
    expect(await runCli(["list", "--db", db, "--json"])).toBe(0);
    const listed = JSON.parse(logs.at(-1) as string);
    expect(listed.items.length).toBeGreaterThan(1);
    expect(listed.next).toBeNull();
    expect(await runCli(["list", "--db", db, "--type", "fact", "--json"])).toBe(
      0,
    );
    expect(
      JSON.parse(logs.at(-1) as string).items.every(
        (e: { type: string }) => e.type === "fact",
      ),
    ).toBe(true);
    expect(await runCli(["list", "--db", db, "--limit", "1", "--json"])).toBe(
      0,
    );
    const page1 = JSON.parse(logs.at(-1) as string);
    expect(page1.items).toHaveLength(1);
    expect(page1.next).toBe(page1.items[0].id);

    // graph: nodes + edges + honest truncation.
    expect(await runCli(["graph", "--db", db, "--json"])).toBe(0);
    const graph = JSON.parse(logs.at(-1) as string);
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.edges.some((r: { to: string }) => r.to === ws)).toBe(true);
    expect(graph.truncated).toBe(false);
    expect(await runCli(["graph", "--db", db, "--limit", "1", "--json"])).toBe(
      0,
    );
    expect(JSON.parse(logs.at(-1) as string).truncated).toBe(true);

    // get --relations: the only way to see an entity's edges from a terminal.
    expect(
      await runCli(["get", fact, "--db", db, "--relations", "--json"]),
    ).toBe(0);
    const got = JSON.parse(logs.at(-1) as string);
    expect(got.id).toBe(fact);
    expect(
      got.relations.some(
        (r: { type: string; other: string }) =>
          r.type === "relates_to" && r.other === ws,
      ),
    ).toBe(true);

    // inject --scope: the CLI could not pass a scope before, so it could not reproduce what MCP
    // returns for the same session.
    expect(
      await runCli([
        "inject",
        "tokenizer",
        "--db",
        db,
        "--scope",
        ws,
        "--json",
      ]),
    ).toBe(0);
    expect(
      JSON.parse(logs.at(-1) as string).some(
        (it: { entity: { id: string } }) => it.entity.id === fact,
      ),
    ).toBe(true);
  });

  it("ontology list + add-type (migration = new version)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // the seed types appear in list
    expect(await runCli(["ontology", "list", "--db", db, "--json"])).toBe(0);
    const listed = JSON.parse(logs.at(-1) as string);
    expect(listed.some((d: { name: string }) => d.name === "decision")).toBe(
      true,
    );

    // add-type: a new type JSON file
    const file = join(dir, "meeting.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "meeting",
        kind: "entity",
        attrs: { topic: { type: "string", required: true } },
        ttl_days: 90,
      }),
    );
    expect(await runCli(["ontology", "add-type", file, "--db", db])).toBe(0);
    expect(logs.at(-1)).toContain("meeting");

    // the new type is reflected in list
    expect(await runCli(["ontology", "list", "--db", db, "--json"])).toBe(0);
    const after = JSON.parse(logs.at(-1) as string);
    expect(after.some((d: { name: string }) => d.name === "meeting")).toBe(
      true,
    );

    // add-type with a missing file → exit 1
    expect(await runCli(["ontology", "add-type", "--db", db])).toBe(1);
  });

  it("history lists all versions; audit records inject events (PLAN 8.4)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=audittoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;
    expect(await runCli(["verify", id, "--db", db])).toBe(0);

    // history: v1 draft + v2 verified, ascending
    expect(await runCli(["history", id, "--db", db, "--json"])).toBe(0);
    const history = JSON.parse(logs.at(-1) as string);
    expect(history.map((e: { version: number }) => e.version)).toEqual([1, 2]);
    expect(history.map((e: { status: string }) => e.status)).toEqual([
      "draft",
      "verified",
    ]);
    // absent id → exit 1
    expect(await runCli(["history", "nope", "--db", db])).toBe(1);

    // inject writes an audit event
    expect(
      await runCli(["inject", "audittoken", "--db", db, "--actor", "alice"]),
    ).toBe(0);
    expect(await runCli(["audit", "--db", db, "--json"])).toBe(0);
    const events = JSON.parse(logs.at(-1) as string) as Array<{
      actor: string;
      action: string;
      detail: string;
    }>;
    // Asserted on the inject row rather than on the total: the `verify` above now writes one too,
    // and a count assertion would have to be revisited every time a path starts being audited.
    const injected = events.find((e) => e.action === "inject");
    expect(injected?.actor).toBe("alice");
    expect(injected?.detail).toContain("audittoken");
    expect(injected?.detail).toContain(id);

    // --since in the future filters it out
    expect(
      await runCli(["audit", "--db", db, "--since", "2099-01-01T00:00:00Z"]),
    ).toBe(0);
    expect(logs.at(-1)).toBe("no audit events");
  });

  it("connect notes ingests transcript chunks as drafts, idempotently (PLAN 8.5)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    const notesDir = join(dir, "notes-fixture");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, "sync.md"),
      "# Sync\nwe chose sqlite\n\nnext review friday\n",
    );

    expect(
      await runCli(["connect", "notes", notesDir, "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual({
      added: 2,
      skipped: 0,
    });
    // re-run skips (external_id idempotency)
    expect(
      await runCli(["connect", "notes", notesDir, "--db", db, "--json"]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual({
      added: 0,
      skipped: 2,
    });

    // staged as drafts (governance: connectors never bypass review)
    expect(await runCli(["review", "--db", db, "--type", "fact"])).toBe(0);
    expect(logs.at(-1)).toContain("we chose sqlite");

    // missing dir arg → usage, exit 1
    expect(await runCli(["connect", "notes", "--db", db])).toBe(1);

    // connect slack without SLACK_TOKEN → exit 1 (no live call)
    expect(
      await runCli(["connect", "slack", "--channel", "C123", "--db", db], {
        ...process.env,
        SLACK_TOKEN: undefined,
      }),
    ).toBe(1);
    expect(errs.at(-1)).toContain("SLACK_TOKEN");
  });

  it("backup → restore round-trip keeps data; safety refusals (PLAN-V2 11.1)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=backuptoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;
    expect(await runCli(["verify", id, "--db", db])).toBe(0);

    // backup, then restore into a fresh dest — data intact.
    const bak = newDb();
    expect(await runCli(["backup", bak, "--db", db])).toBe(0);
    const dest = newDb();
    expect(await runCli(["restore", bak, "--db", dest])).toBe(0);
    expect(await runCli(["get", id, "--db", dest, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).status).toBe("verified");

    // refuses to clobber an existing DB without --force; --force allows it.
    expect(await runCli(["restore", bak, "--db", dest])).toBe(1);
    expect(errs.at(-1)).toContain("refusing to overwrite");
    expect(await runCli(["restore", bak, "--db", dest, "--force"])).toBe(0);

    // refuses a source that is not a valid yoke DB.
    const junk = newDb();
    const j = new Database(junk);
    j.exec("CREATE TABLE x(a)");
    j.close();
    const dest2 = newDb();
    expect(await runCli(["restore", junk, "--db", dest2])).toBe(1);
    expect(errs.at(-1)).toContain("not a valid yoke DB");
  });

  it("export --until reconstructs a point-in-time DB (PLAN-V2 11.1)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "title=pitrtoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;

    const out = newDb();
    // A far-future cut captures everything created so far, including the draft.
    expect(
      await runCli([
        "export",
        "--db",
        db,
        "--until",
        "2099-01-01T00:00:00Z",
        "--out",
        out,
      ]),
    ).toBe(0);
    const store = new SqliteStorage(out);
    await store.init();
    expect((await store.getEntity(id))?.status).toBe("draft");
    store.close();

    // missing flags → usage, exit 1
    expect(await runCli(["export", "--db", db, "--out", out])).toBe(1);
  });

  it("namespace isolation: add in ns A is invisible from ns B, visible from ns A", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);

    // add a fact into namespace "tenant-a"
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--ns",
        "tenant-a",
        "--attr",
        "title=nstoken",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;

    // search in ns B → empty
    expect(
      await runCli([
        "search",
        "nstoken",
        "--db",
        db,
        "--ns",
        "tenant-b",
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual([]);

    // search in default ns → empty (isolation from the shared namespace too)
    expect(await runCli(["search", "nstoken", "--db", db, "--json"])).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual([]);

    // search in ns A → hit
    expect(
      await runCli([
        "search",
        "nstoken",
        "--db",
        db,
        "--ns",
        "tenant-a",
        "--json",
      ]),
    ).toBe(0);
    const found = JSON.parse(logs.at(-1) as string);
    expect(found.some((e: { id: string }) => e.id === id)).toBe(true);

    // YOKE_NS env is honored when --ns is absent
    expect(
      await runCli(["search", "nstoken", "--db", db, "--json"], {
        ...process.env,
        YOKE_NS: "tenant-a",
      }),
    ).toBe(0);
    expect(
      (JSON.parse(logs.at(-1) as string) as { id: string }[]).some(
        (e) => e.id === id,
      ),
    ).toBe(true);
  });

  it("--help / no args / 'help' print grouped usage and exit 0", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], []]) {
      expect(await runCli(argv.concat(["--db", newDb()]))).toBe(0);
      expect(logs.at(-1)).toContain("getting started");
    }
    // Unknown command shows the same usage but exits 1.
    expect(await runCli(["frobnicate", "--db", newDb()])).toBe(1);
    expect(errs.at(-1)).toContain("getting started");
  });

  it("ontology-needing commands on an uninitialized DB point at 'yoke init'", async () => {
    const db = newDb();
    expect(await runCli(["add", "fact", "--db", db, "--attr", "note=x"])).toBe(
      1,
    );
    expect(errs.at(-1)).toContain("yoke init");
    expect(await runCli(["inject", "anything", "--db", db])).toBe(1);
    expect(errs.at(-1)).toContain("yoke init");
  });

  it("inject with only draft matches says the drafts were withheld (json stays raw)", async () => {
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli(["add", "fact", "--db", db, "--attr", "note=quarantined"]),
    ).toBe(0);

    expect(await runCli(["inject", "quarantined", "--db", db])).toBe(0);
    expect(logs.at(-1)).toContain("withheld");
    expect(logs.at(-1)).toContain("yoke review");

    // --json contract unchanged: raw (empty) items array, no hint text.
    expect(await runCli(["inject", "quarantined", "--db", db, "--json"])).toBe(
      0,
    );
    expect(JSON.parse(logs.at(-1) as string)).toEqual([]);

    // A genuinely absent topic still reads "no results".
    expect(await runCli(["inject", "nonexistent-topic", "--db", db])).toBe(0);
    expect(logs.at(-1)).toBe("no results");
  });

  it("audits every governance act and knowledge read, not just inject", async () => {
    // The web tier audited verify/deprecate/persona and the CLI audited only inject — so the trail
    // could not answer "who promoted this" for any promotion done the normal way (ROADMAP v0.2 makes
    // the CLI the primary interface for review/verify). Found by generating traffic and watching the
    // rows fail to appear, not by a test.
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "person",
        "--db",
        db,
        "--attr",
        "name=Dana",
        "--json",
      ]),
    ).toBe(0);
    const person = JSON.parse(logs.at(-1) as string).id as string;
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "statement=governed knowledge",
        "--actor",
        person,
        "--json",
      ]),
    ).toBe(0);
    const fact = JSON.parse(logs.at(-1) as string).id as string;

    expect(
      await runCli(["verify", fact, person, "--db", db, "--actor", "reviewer"]),
    ).toBe(0);
    expect(
      await runCli([
        "persona",
        person,
        "--db",
        db,
        "--out",
        dir,
        "--actor",
        "reader",
      ]),
    ).toBe(0);
    expect(
      await runCli(["deprecate", fact, "--db", db, "--actor", "retirer"]),
    ).toBe(0);

    expect(await runCli(["audit", "--db", db, "--json"])).toBe(0);
    const events = JSON.parse(logs.at(-1) as string) as Array<{
      actor: string;
      action: string;
      detail: string;
    }>;
    const byAction = new Map(events.map((e) => [e.action, e]));

    // Each act names its own actor — that is the column the trail exists for.
    expect(byAction.get("verify")?.actor).toBe("reviewer");
    expect(byAction.get("verify")?.detail).toContain(fact);
    expect(byAction.get("deprecate")?.actor).toBe("retirer");
    expect(byAction.get("deprecate")?.detail).toContain(fact);
    // A persona read is an injection, and this one also writes a SKILL.md into someone's prompt.
    expect(byAction.get("persona")?.actor).toBe("reader");
    expect(byAction.get("persona")?.detail).toContain(person);
  });

  it("audits the same action names in the CLI as the web tier does", async () => {
    // Parity guard. The two front adapters drifted once: the web audited three actions the CLI did
    // not, and nothing compared them. Any new governance path must name an action already understood
    // by the audit viewer, whose MEANING map is keyed on exactly these.
    const db = newDb();
    expect(await runCli(["init", "--db", db])).toBe(0);
    expect(
      await runCli([
        "add",
        "fact",
        "--db",
        db,
        "--attr",
        "statement=parity",
        "--json",
      ]),
    ).toBe(0);
    const id = JSON.parse(logs.at(-1) as string).id as string;
    expect(await runCli(["verify", id, "--db", db])).toBe(0);
    expect(await runCli(["inject", "parity", "--db", db])).toBe(0);
    expect(await runCli(["deprecate", id, "--db", db])).toBe(0);
    // The one mutation the version history cannot record, because it rewrites those very rows.
    expect(await runCli(["rename-type", "term", "glossary", "--db", db])).toBe(
      0,
    );
    expect(await runCli(["audit", "--db", db, "--json"])).toBe(0);
    const seen = new Set(
      (JSON.parse(logs.at(-1) as string) as Array<{ action: string }>).map(
        (e) => e.action,
      ),
    );
    for (const a of ["verify", "inject", "deprecate", "rename_type"])
      expect(seen, `${a} must be audited`).toContain(a);
    // inject_preview is the web tier's alone on purpose: it records that a HUMAN looked, without
    // polluting "what the AI actually saw". The CLI has no preview, so it must never write one.
    expect(seen).not.toContain("inject_preview");
  });
});
