// RBAC unit table (PLAN-V2 10.4). Scope grammar × requests. Key invariants: deny-by-default,
// write does NOT imply verify, ns mismatch denies, wildcards match narrower requests.

import { describe, expect, it } from "vitest";
import { allowed, parseScope } from "./rbac.js";

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
