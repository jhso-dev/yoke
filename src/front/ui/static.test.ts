// Static-serving tests. The path resolver is the trust boundary, so the traversal cases are the
// point of this file; they run against a fixture directory and need no built bundle (CI runs tests
// before build, so nothing here may depend on one existing).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticHandler, resolveAssetPath } from "./static.js";

const dir = mkdtempSync(join(tmpdir(), "yoke-static-"));
const root = resolve(join(dir, "app"));
let server: Server;
let base: string;

beforeAll(async () => {
  mkdirSync(join(root, "_next", "static"), { recursive: true });
  mkdirSync(join(root, "entity"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>shell</h1>");
  writeFileSync(join(root, "404.html"), "<h1>missing</h1>");
  writeFileSync(join(root, "entity", "index.html"), "<h1>entity</h1>");
  writeFileSync(join(root, "audit.html"), "<h1>audit</h1>");
  // Over 1 KiB so gzip negotiation has something to compress.
  writeFileSync(
    join(root, "_next", "static", "chunk.js"),
    `//${"x".repeat(2000)}`,
  );
  // A secret OUTSIDE the bundle root — every traversal case tries to reach this.
  writeFileSync(join(dir, "secret.txt"), "do not serve me");

  const handler = createStaticHandler(root);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    handler(req, res, path)
      .then((served) => {
        if (!served) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      })
      .catch(() => res.end());
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveAssetPath (trust boundary)", () => {
  it("refuses to escape the bundle root, however the escape is spelled", () => {
    for (const attempt of [
      "/../secret.txt",
      "/../../etc/passwd",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/%2e%2e/secret.txt",
      "/\\..\\secret.txt",
      "/entity/../../secret.txt",
      "/%00/secret.txt",
      "/%zz",
    ]) {
      expect(resolveAssetPath(root, attempt), attempt).toBeNull();
    }
  });

  it("resolves directories to index.html and bare paths to .html", () => {
    expect(resolveAssetPath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveAssetPath(root, "/entity/")).toBe(
      join(root, "entity", "index.html"),
    );
    // No trailing slash still finds the directory index...
    expect(resolveAssetPath(root, "/entity")).toBe(
      join(root, "entity", "index.html"),
    );
    // ...and a bare path falls back to the sibling .html an export may emit instead.
    expect(resolveAssetPath(root, "/audit")).toBe(join(root, "audit.html"));
    expect(resolveAssetPath(root, "/nope")).toBeNull();
  });
});

describe("static handler", () => {
  it("serves the shell with a CSP and no-cache, and hashed chunks as immutable", async () => {
    const shell = await fetch(base + "/");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    expect(shell.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(shell.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await shell.text()).toContain("shell");

    const chunk = await fetch(base + "/_next/static/chunk.js");
    expect(chunk.headers.get("cache-control")).toContain("immutable");
    expect(chunk.headers.get("content-type")).toContain("text/javascript");
  });

  it("gzips a large textual asset when asked, and not otherwise", async () => {
    const zipped = await fetch(base + "/_next/static/chunk.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toBe("accept-encoding");
    // fetch decompresses transparently, so the body must still be intact.
    expect((await zipped.text()).length).toBeGreaterThan(1024);

    // The shell is under 1 KiB → not worth compressing.
    const small = await fetch(base + "/", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(small.headers.get("content-encoding")).toBeNull();
  });

  it("returns false (caller 404s) for an unresolvable path, and never serves outside root", async () => {
    expect((await fetch(base + "/nope")).status).toBe(404);
    const escaped = await fetch(base + "/%2e%2e%2fsecret.txt");
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("do not serve me");
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await fetch(base + "/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("14");
    expect(await res.text()).toBe("");
  });

  it("reports unavailable when the bundle directory is absent", async () => {
    const missing = createStaticHandler(join(dir, "not-built"));
    expect(missing.available).toBe(false);
    // A null root (nothing resolved at all) is the same state, not a crash.
    expect(createStaticHandler(null).available).toBe(false);
  });
});
