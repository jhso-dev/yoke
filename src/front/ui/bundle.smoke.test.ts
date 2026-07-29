// The check whose absence let v2.5 ship an inert UI.
//
// The old tests asserted that GET / contained `data-tab="review"`. That string was present, CI was
// green, and the client script was a SyntaxError from an unterminated string literal — so no tab
// switched and no row loaded in a browser. A substring assertion is not evidence that a UI works.
//
// This boots the real server against the real built bundle, follows the script tags the shell
// actually references, and PARSES them. It costs no browser and no new dependency. It skips when
// there is no build, because CI runs tests before build and no test may require one.

import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStaticHandler } from "./static.js";

const bundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../dist/front/ui/app",
);
const built = existsSync(join(bundle, "index.html"));

describe.skipIf(!built)("shipped web bundle", () => {
  it("serves a shell whose scripts actually parse", async () => {
    const handler = createStaticHandler(bundle);
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      handler(req, res, path).then((served) => {
        if (!served) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;

    try {
      const shell = await fetch(`${base}/`);
      expect(shell.status).toBe(200);
      const html = await shell.text();

      // Every script the shell references must resolve AND parse. A 404 here means the export and
      // the copy step disagree; a SyntaxError means we shipped code no browser can run.
      const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
        (m) => m[1],
      );
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) {
        const res = await fetch(base + src);
        expect(res.status, `${src} must be served`).toBe(200);
        const code = await res.text();
        // new Function parses without executing — no DOM needed, and a syntax error throws here.
        expect(() => new Function(code), `${src} must parse`).not.toThrow();
      }

      // Inline scripts too: that is exactly where the v2.5 failure lived.
      for (const [, code] of html.matchAll(
        /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,
      )) {
        if (code.trim())
          expect(
            () => new Function(code),
            "inline script must parse",
          ).not.toThrow();
      }
    } finally {
      server.close();
    }
  });

  it("ships every screen as a real page, not a client-side fallback", async () => {
    // A static export has one file per route. If a screen is missing, the server 404s rather than
    // silently returning the shell — so this catches "the route was never exported".
    for (const screen of [
      "review",
      "conflicts",
      "ontology",
      "persona",
      "browse",
      "entity",
      "inject",
      "audit",
      "login",
    ]) {
      expect(
        existsSync(join(bundle, screen, "index.html")),
        `${screen} must be exported`,
      ).toBe(true);
    }
  });
});
