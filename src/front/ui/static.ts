// Static file serving for the built web bundle. node:http only — no express, no static middleware.
//
// The path resolver is a pure function so the trust boundary is unit-testable without a server: it
// is the one place a crafted URL could reach outside the bundle directory, and "reject unless the
// resolved path is inside root" is the check that makes that impossible.

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** content-type by extension. Ten entries covers everything a static export emits. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const TEXTUAL = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".map",
]);

/**
 * Resolve a URL path to a file inside root, or null when it does not resolve to one.
 *
 * The order matters: decode first (so `%2e%2e%2f` is seen as `../`), then containment-check the
 * resolved absolute path. Checking the raw string instead would miss every encoded traversal.
 * A static export has no dynamic routes, so there is deliberately no SPA catch-all: a typo'd URL
 * returning the app shell with status 200 would be a lie.
 */
export function resolveAssetPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;
  // win32 accepts backslash as a separator, so normalize it before resolving.
  const rel = decoded.replace(/\\/g, "/");
  const withIndex = rel.endsWith("/") ? `${rel}index.html` : rel;
  const abs = path.resolve(
    root,
    `.${withIndex.startsWith("/") ? "" : "/"}${withIndex}`,
  );
  // The trust boundary. `root` itself is allowed; anything not under it is not.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;

  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) return abs;
    const index = path.join(abs, "index.html");
    return existsSync(index) ? index : null;
  }
  // `/entity` → `/entity.html`, which is what an export without trailingSlash emits.
  const asHtml = `${abs}.html`;
  return existsSync(asHtml) ? asHtml : null;
}

/** Cache-Control per asset class. Content-hashed chunks are immutable; the shell must not be. */
function cacheControl(file: string): string {
  if (file.includes(`${path.sep}_next${path.sep}static${path.sep}`))
    return "public, max-age=31536000, immutable";
  if (file.endsWith(".html")) return "no-cache";
  return "public, max-age=300";
}

/**
 * `default-src 'self'` with inline script/style allowed.
 *
 * ponytail: 'unsafe-inline' in script-src is forced by static export — the exported HTML carries
 * an inline bootstrap, and nonces require dynamic rendering, which `output: 'export'` removes. This
 * is a real cost of that choice, not an oversight. Upgrade path: hash each inline <script> at build
 * time and emit a per-file header map here.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface StaticHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
  ): Promise<boolean>;
  /** False when the bundle directory is absent — callers answer 503 with a build hint. */
  readonly available: boolean;
}

/** Serve files from root. Returns false when the request resolved to nothing (caller 404s). */
export function createStaticHandler(root: string | null): StaticHandler {
  const available = root !== null && existsSync(root);
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
  ): Promise<boolean> => {
    if (!available || root === null) return false;
    const file = resolveAssetPath(root, urlPath);
    if (!file) return false;

    const ext = path.extname(file);
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": cacheControl(file),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    if (ext === ".html") headers["content-security-policy"] = CSP;

    const size = statSync(file).size;
    // gzip only where it pays: textual, over 1 KiB, and the client asked. The exported JS bundle is
    // the one payload large enough to matter over a WAN (`serve --auth`).
    const wantsGzip =
      TEXTUAL.has(ext) &&
      size > 1024 &&
      (req.headers["accept-encoding"] ?? "").includes("gzip");
    if (wantsGzip) {
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
    } else {
      headers["content-length"] = String(size);
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const stream = createReadStream(file);
    if (wantsGzip) await pipeline(stream, createGzip(), res);
    else await pipeline(stream, res);
    return true;
  };
  return Object.assign(handler, { available });
}
