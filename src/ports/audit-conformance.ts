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
      action: "inject",
      detail: "cache -> id1",
      at: "2026-01-01T00:00:00Z",
    };
    const b = {
      actor: "bob",
      action: "persona",
      detail: "p1 -> id3",
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
        action: "verify",
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
  });
}
