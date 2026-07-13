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
    const events = JSON.parse(logs.at(-1) as string);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("alice");
    expect(events[0].action).toBe("inject");
    expect(events[0].detail).toContain("audittoken");
    expect(events[0].detail).toContain(id);

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
});
