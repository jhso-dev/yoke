// AuditPort conformance suite — every ledger answers these the same way, whatever it is underneath.
//
// Invariant 2 in one file: the trail is a user-facing capability, so no backend may have a version of
// it that behaves differently. The cases are about the two things a caller depends on and cannot see
// from a signature — that reads come back oldest-first even when `limit` selects from the newest end,
// and that bounds compare BY INSTANT, never as text (`at` holds more than one ISO spelling, and `Z`
// sorts after `.`, so a string compare drops rows inside the bound's own second).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditPort } from "./audit.js";

export function describeAuditPort(
  name: string,
  make: () => Promise<AuditPort>,
): void {
  describe(`AuditPort conformance: ${name}`, () => {
    let port: AuditPort;
    beforeEach(async () => {
      port = await make();
      await port.init();
    });
    afterEach(() => port.close());

    const a = {
      actor: "alice",
      action: "read" as const,
      detail: "id1",
      at: "2026-01-01T00:00:00Z",
    };
    const b = {
      actor: "bob",
      action: "search" as const,
      detail: "cache -> id3",
      at: "2026-02-01T00:00:00Z",
    };
    const tenant = {
      ...a,
      actor: "carol",
      at: "2026-03-01T00:00:00Z",
      ns: "acme",
    };

    it("round-trips oldest-first, and the default namespace is not a wildcard", async () => {
      await port.logAudit(a);
      await port.logAudit(b);
      await port.logAudit(tenant);
      expect(await port.listAudit()).toEqual([a, b]);
      expect(await port.listAudit({ ns: "acme" })).toEqual([tenant]);
      expect(await port.listAudit({ ns: "globex" })).toEqual([]);
    });

    it("bounds are inclusive on both ends", async () => {
      await port.logAudit(a);
      await port.logAudit(b);
      expect(await port.listAudit({ since: b.at })).toEqual([b]);
      expect(await port.listAudit({ until: a.at })).toEqual([a]);
      expect(await port.listAudit({ since: a.at, until: b.at })).toEqual([
        a,
        b,
      ]);
    });

    it("limit takes the most recent N and still returns them oldest-first", async () => {
      await port.logAudit(a);
      await port.logAudit(b);
      expect(await port.listAudit({ limit: 1 })).toEqual([b]);
      expect(await port.listAudit({ limit: 5 })).toEqual([a, b]);
    });

    it("compares a bound by instant, not as text", async () => {
      const ms = {
        actor: "dave",
        action: "verify" as const,
        detail: "id5",
        at: "2026-04-01T00:00:00.500Z",
      };
      await port.logAudit(ms);
      // Whole-second and millisecond spellings of the same bound select the same row. A string
      // compare passes the first and fails the second.
      expect(
        await port.listAudit({ since: "2026-04-01T00:00:00.000Z" }),
      ).toEqual([ms]);
      expect(await port.listAudit({ since: "2026-04-01T00:00:00Z" })).toEqual([
        ms,
      ]);
      // An offset spelling of an instant BEFORE the row still selects it,
      expect(
        await port.listAudit({ since: "2026-04-01T09:00:00+09:00" }),
      ).toEqual([ms]);
      // and one millisecond AFTER it excludes it. A bound is a bound in every spelling.
      expect(
        await port.listAudit({ since: "2026-04-01T00:00:00.501Z" }),
      ).toEqual([]);
    });

    it("an empty ledger reads as empty, not as an error", async () => {
      expect(await port.listAudit()).toEqual([]);
      expect(await port.listAudit({ limit: 10 })).toEqual([]);
    });

    // --- what the ledger implies -----------------------------------------------------------------
    // `ids` is the whole interface: an event that carries them handed records to an AGENT, and one
    // that does not did something else. No caller re-derives this from `detail`.

    const handed = (
      at: string,
      ids: string[],
      extra: Partial<{ actor: string; anchor: string; asOf: string }> = {},
    ) => ({
      actor: extra.actor ?? "agent",
      action: "inject" as const,
      detail: `x -> ${ids.join(" ")}`,
      at,
      ids,
      ...(extra.anchor === undefined ? {} : { anchor: extra.anchor }),
      ...(extra.asOf === undefined ? {} : { asOf: extra.asOf }),
    });

    it("counts a delivery per id, over every reader and context", async () => {
      await port.logAudit(handed("2026-09-01T00:00:00Z", ["A", "B"]));
      await port.logAudit(
        handed("2026-09-02T00:00:00Z", ["B"], { anchor: "S1" }),
      );
      await port.logAudit(
        handed("2026-09-03T00:00:00Z", ["B", "C"], { actor: "other" }),
      );
      expect(await port.consumption({ ids: ["A", "B", "C"] })).toEqual(
        new Map([
          ["A", 1],
          ["B", 3],
          ["C", 1],
        ]),
      );
      // An id nothing was ever handed is absent, not zero — the caller distinguishes them.
      expect(await port.consumption({ ids: ["Z"] })).toEqual(new Map());
      expect(await port.consumption({ ids: [] })).toEqual(new Map());
    });

    it("an event with no ids is not a delivery", async () => {
      // A human governing — `inject_preview`, `read`, `search`, `verify`. The question consumption
      // answers is what AGENTS are being fed.
      for (const action of [
        "inject_preview",
        "read",
        "search",
        "verify",
      ] as const)
        await port.logAudit({
          actor: "human",
          action,
          detail: "q -> A",
          at: "2026-09-01T00:00:00Z",
        });
      expect(await port.consumption({ ids: ["A"] })).toEqual(new Map());
      expect(await port.lastHanded({ actor: "human", ids: ["A"] })).toEqual(
        new Map(),
      );
      expect(
        (await port.delivered({ actor: "human", anchor: "S1" })).ids.size,
      ).toBe(0);
    });

    it("per id the latest handing, over every working context", async () => {
      await port.logAudit(handed("2026-09-01T00:00:00Z", ["A", "B"]));
      await port.logAudit(
        handed("2026-09-02T00:00:00Z", ["B", "C"], { anchor: "S1" }),
      );
      await port.logAudit({
        ...handed("2026-09-03T00:00:00Z", ["C"]),
        action: "persona" as const,
      });
      await port.logAudit(
        handed("2026-09-04T00:00:00Z", ["D"], { anchor: "S2" }),
      );
      expect(
        await port.lastHanded({ actor: "agent", ids: ["A", "B", "C", "D"] }),
      ).toEqual(
        new Map([
          ["A", "2026-09-01T00:00:00Z"],
          ["B", "2026-09-02T00:00:00Z"],
          ["C", "2026-09-03T00:00:00Z"],
          ["D", "2026-09-04T00:00:00Z"],
        ]),
      );
      // One reader's deliveries are not another's.
      expect(
        await port.lastHanded({ actor: "other", ids: ["A", "B", "C", "D"] }),
      ).toEqual(new Map());
    });

    it("answers for the ids asked for and no others", async () => {
      await port.logAudit(handed("2026-09-01T00:00:00Z", ["A", "B"]));
      // Not a scan of the held set: B was handed over and is still absent, because nobody asked.
      expect(await port.lastHanded({ actor: "agent", ids: ["A"] })).toEqual(
        new Map([["A", "2026-09-01T00:00:00Z"]]),
      );
      // An id never delivered is absent, not present with an empty clock.
      expect(
        await port.lastHanded({ actor: "agent", ids: ["A", "Z"] }),
      ).toEqual(new Map([["A", "2026-09-01T00:00:00Z"]]));
      expect(await port.lastHanded({ actor: "agent", ids: [] })).toEqual(
        new Map(),
      );
    });

    it("one anchor's last row and every id it handed, and nothing from another", async () => {
      await port.logAudit(
        handed("2026-09-02T00:00:00Z", ["B", "C"], { anchor: "S1" }),
      );
      // Another context's briefing: its ids count as handed, its instant is not this anchor's.
      await port.logAudit(
        handed("2026-09-04T00:00:00Z", ["D"], { anchor: "S2" }),
      );
      const d = await port.delivered({ actor: "agent", anchor: "S1" });
      expect(d.last).toBe("2026-09-02T00:00:00Z");
      expect([...d.ids].sort()).toEqual(["B", "C"]);
      // One reader's deliveries are not another's.
      expect(
        (await port.delivered({ actor: "other", anchor: "S1" })).ids.size,
      ).toBe(0);
    });

    it("an as-of delivery counts as consumption but does not advance the clock", async () => {
      // It handed a version that was current THEN, so it says nothing about whether the reader holds
      // the current one — and the record it rewound is not part of the context's held set.
      await port.logAudit(
        handed("2026-09-06T00:00:00Z", ["F"], {
          anchor: "S1",
          asOf: "2026-01-01T00:00:00Z",
        }),
      );
      expect(await port.consumption({ ids: ["F"] })).toEqual(
        new Map([["F", 1]]),
      );
      expect(await port.lastHanded({ actor: "agent", ids: ["F"] })).toEqual(
        new Map(),
      );
      const d = await port.delivered({ actor: "agent", anchor: "S1" });
      expect(d.ids.has("F")).toBe(false);
      expect(d.last).toBeUndefined();

      // And a real delivery afterwards does advance it, over the same row.
      await port.logAudit(
        handed("2026-09-07T00:00:00Z", ["F"], { anchor: "S1" }),
      );
      expect(await port.lastHanded({ actor: "agent", ids: ["F"] })).toEqual(
        new Map([["F", "2026-09-07T00:00:00Z"]]),
      );
      expect(await port.consumption({ ids: ["F"] })).toEqual(
        new Map([["F", 2]]),
      );
      // An as-of delivery AFTER a real one leaves the clock where it was.
      await port.logAudit(
        handed("2026-09-08T00:00:00Z", ["F"], {
          anchor: "S1",
          asOf: "2026-01-01T00:00:00Z",
        }),
      );
      expect(await port.lastHanded({ actor: "agent", ids: ["F"] })).toEqual(
        new Map([["F", "2026-09-07T00:00:00Z"]]),
      );
      expect(
        (await port.delivered({ actor: "agent", anchor: "S1" })).last,
      ).toBe("2026-09-07T00:00:00Z");
    });

    it("latest by instant, not by row order or spelling", async () => {
      // `at` is stored in more than one ISO spelling and `Z` collates after `.`, so a string compare
      // would call the whole-second row the later one.
      await port.logAudit(
        handed("2026-09-01T00:00:00.500Z", ["A"], { anchor: "S" }),
      );
      await port.logAudit(
        handed("2026-09-01T00:00:00Z", ["A"], { anchor: "S" }),
      );
      // The same two instants across two contexts, so `lastHanded` chooses across rows rather than
      // reading one row's winner back.
      await port.logAudit(
        handed("2026-09-01T00:00:00.500Z", ["B"], { anchor: "S" }),
      );
      await port.logAudit(
        handed("2026-09-01T00:00:00Z", ["B"], { anchor: "T" }),
      );
      expect(
        await port.lastHanded({ actor: "agent", ids: ["A", "B"] }),
      ).toEqual(
        new Map([
          ["A", "2026-09-01T00:00:00.500Z"],
          ["B", "2026-09-01T00:00:00.500Z"],
        ]),
      );
      expect((await port.delivered({ actor: "agent", anchor: "S" })).last).toBe(
        "2026-09-01T00:00:00.500Z",
      );
    });

    it("an anchor with no deliveries has no bound", async () => {
      await port.logAudit(
        handed("2026-09-01T00:00:00Z", ["A"], { anchor: "other" }),
      );
      const d = await port.delivered({ actor: "agent", anchor: "S" });
      expect(d.last).toBeUndefined();
      expect(d.ids.size).toBe(0);
      // Still held, though: what a reader holds is not a per-context fact.
      expect(await port.lastHanded({ actor: "agent", ids: ["A"] })).toEqual(
        new Map([["A", "2026-09-01T00:00:00Z"]]),
      );
    });

    it("a namespace's deliveries are its own", async () => {
      await port.logAudit(handed("2026-09-01T00:00:00Z", ["A"], {}));
      await port.logAudit({
        ...handed("2026-09-02T00:00:00Z", ["A"], {}),
        ns: "acme",
      });
      expect(await port.consumption({ ids: ["A"] })).toEqual(
        new Map([["A", 1]]),
      );
      expect(await port.consumption({ ns: "acme", ids: ["A"] })).toEqual(
        new Map([["A", 1]]),
      );
      expect(await port.consumption({ ns: "globex", ids: ["A"] })).toEqual(
        new Map(),
      );
      // And so is the clock: the same id, handed in two namespaces, keeps two.
      expect(await port.lastHanded({ actor: "agent", ids: ["A"] })).toEqual(
        new Map([["A", "2026-09-01T00:00:00Z"]]),
      );
      expect(
        await port.lastHanded({ ns: "acme", actor: "agent", ids: ["A"] }),
      ).toEqual(new Map([["A", "2026-09-02T00:00:00Z"]]));
      expect(
        await port.lastHanded({ ns: "globex", actor: "agent", ids: ["A"] }),
      ).toEqual(new Map());
    });
  });
}
