// RBAC unit table (PLAN-V2 10.4). Scope grammar × requests. Key invariants: deny-by-default,
// write does NOT imply verify, ns mismatch denies, wildcards match narrower requests.

import { describe, expect, it } from "vitest";
import { allowed, parseScope, ungrantable } from "./rbac.js";

describe("rbac allowed()", () => {
  it("deny by default (no scopes)", () => {
    expect(allowed([], null, undefined, "read")).toBe(false);
  });

  it("bare action = wildcard ns+type, matches the default namespace", () => {
    expect(allowed(["read"], null, "fact", "read")).toBe(true);
    expect(allowed(["read"], "tenantA", "fact", "read")).toBe(true);
  });

  it("write does NOT imply verify (verify is the governance permission)", () => {
    expect(allowed(["write"], null, "fact", "write")).toBe(true);
    expect(allowed(["write"], null, "fact", "verify")).toBe(false);
    expect(allowed(["read"], null, "fact", "write")).toBe(false);
  });

  it("ns:action scopes only match that exact namespace", () => {
    expect(allowed(["tenantA:read"], "tenantA", "fact", "read")).toBe(true);
    expect(allowed(["tenantA:read"], "tenantB", "fact", "read")).toBe(false);
    // a named-ns scope does NOT grant the default (null) namespace
    expect(allowed(["tenantA:read"], null, "fact", "read")).toBe(false);
  });

  it("ns:type:action scopes are type-specific; untyped requests need a type wildcard", () => {
    expect(allowed(["tenantA:fact:verify"], "tenantA", "fact", "verify")).toBe(
      true,
    );
    expect(allowed(["tenantA:fact:verify"], "tenantA", "term", "verify")).toBe(
      false,
    );
    // an untyped request (type === undefined) is not granted by a type-specific scope
    expect(
      allowed(["tenantA:fact:verify"], "tenantA", undefined, "verify"),
    ).toBe(false);
    // ...but a type-wildcard scope grants it
    expect(allowed(["tenantA:verify"], "tenantA", undefined, "verify")).toBe(
      true,
    );
  });

  it("agent default (write-only) can stage but cannot verify", () => {
    const agent = ["write"];
    expect(allowed(agent, null, "fact", "write")).toBe(true);
    expect(allowed(agent, null, "fact", "verify")).toBe(false);
  });

  it("malformed scopes are ignored (unknown action → parse null)", () => {
    expect(parseScope("bogus")).toBeNull();
    expect(parseScope("a:b:c:d")).toBeNull();
    expect(allowed(["bogus", "read"], null, undefined, "read")).toBe(true);
    expect(allowed(["bogus"], null, undefined, "read")).toBe(false);
  });
});

// `admin` was missing, and `verify` stood in for it: every reviewer could mint, list and revoke
// credentials for every tenant. ENTERPRISE.md claimed the separation the code did not have.
describe("admin is its own axis", () => {
  it("verify does not grant admin, and admin does not grant verify", () => {
    expect(allowed(["teamA:verify"], "teamA", undefined, "admin")).toBe(false);
    expect(allowed(["teamA:admin"], "teamA", undefined, "verify")).toBe(false);
  });

  it("admin does not imply reading knowledge", () => {
    // The point of the separation: whoever hands out credentials is not automatically able to read
    // every tenant's knowledge.
    expect(allowed(["teamA:admin"], "teamA", undefined, "read")).toBe(false);
  });

  it("is a real action rather than a typo the parser drops", () => {
    expect(parseScope("teamA:admin")).toEqual({
      ns: "teamA",
      type: null,
      action: "admin",
    });
    expect(parseScope("teamA:administrator")).toBeNull();
  });
});

// Holding admin is permission to run the credential routes; it is not permission to write any scope
// string into a token. Without this the escalation just takes two steps: mint `["*:read"]`, then use it.
describe("ungrantable()", () => {
  it("lets a namespace admin grant inside its own namespace", () => {
    expect(
      ungrantable(["teamA:admin"], ["teamA:read", "teamA:fact:verify"]),
    ).toEqual([]);
  });

  it("refuses another namespace", () => {
    expect(ungrantable(["teamA:admin"], ["teamB:read"])).toEqual([
      "teamB:read",
    ]);
  });

  it("refuses a wildcard-namespace scope, which is the whole deployment", () => {
    expect(ungrantable(["teamA:admin"], ["read"])).toEqual(["read"]);
    expect(ungrantable(["teamA:admin"], ["*:read"])).toEqual(["*:read"]);
  });

  it("lets a wildcard admin grant anything", () => {
    expect(ungrantable(["admin"], ["read", "teamB:verify", "*:write"])).toEqual(
      [],
    );
  });

  it("names every scope out of reach, not just the first", () => {
    expect(
      ungrantable(["teamA:admin"], ["teamA:read", "teamB:read", "read"]),
    ).toEqual(["teamB:read", "read"]);
  });

  it("refuses an unparseable scope rather than treating it as grantable", () => {
    expect(ungrantable(["admin"], ["reed"])).toEqual([]);
    expect(ungrantable(["teamA:admin"], ["reed"])).toEqual(["reed"]);
  });

  it("grants nothing without an admin scope at all", () => {
    expect(ungrantable(["teamA:verify"], ["teamA:read"])).toEqual([
      "teamA:read",
    ]);
  });
});
