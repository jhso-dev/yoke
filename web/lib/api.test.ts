// The credential and error handling live in one place, so this is where they get pinned. Plain .ts
// with no JSX and no DOM, which is why the root vitest collects it with no config change — the
// testable logic is deliberately kept out of .tsx files for exactly that reason.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, configureApi } from "./api";
import { clearCredential, getCredential, setCredential } from "./credential";

/** Await a call that must reject, and return its error. Also asserts that it DID reject — a
 * resolving call would otherwise silently skip the assertions below it. */
async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected the request to reject");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearCredential();
  configureApi({ onUnauthorized: () => {} });
});

describe("apiFetch", () => {
  it("attaches the credential when there is one, and omits the header when there is not", async () => {
    const seen: RequestInit[] = [];
    configureApi({
      fetchImpl: async (_url, init) => {
        seen.push(init ?? {});
        return jsonResponse([]);
      },
    });

    await api.review();
    expect(
      (seen[0].headers as Record<string, string>).authorization,
    ).toBeUndefined();

    setCredential("tok-abc");
    await api.review();
    expect((seen[1].headers as Record<string, string>).authorization).toBe(
      "Bearer tok-abc",
    );
  });

  it("clears the credential and notifies on 401, so a revoked token cannot keep failing silently", async () => {
    setCredential("revoked");
    const onUnauthorized = vi.fn();
    configureApi({
      fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
      onUnauthorized,
    });

    await expect(api.review()).rejects.toBeInstanceOf(ApiError);
    expect(getCredential()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("surfaces the server's error message, and keeps the credential on 403", async () => {
    setCredential("read-only");
    configureApi({
      fetchImpl: async () => jsonResponse({ error: "forbidden" }, 403),
    });
    const err = await rejection(api.verify(["x"]));
    expect(err.forbidden).toBe(true);
    expect(err.message).toBe("forbidden");
    // 403 means "authenticated, wrong scope" — re-pasting the same token would not help, so it stays.
    expect(getCredential()).toBe("read-only");
  });

  it("falls back to a status message when the error body is not JSON", async () => {
    configureApi({
      fetchImpl: async () => new Response("<html>502</html>", { status: 502 }),
    });
    const err = await rejection(api.review());
    expect(err.status).toBe(502);
    expect(err.message).toContain("502");
  });

  it("builds query strings, dropping undefined and empty values", async () => {
    const urls: string[] = [];
    configureApi({
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ items: [], next: null });
      },
    });
    await api.entities({ type: "fact", limit: 10 });
    await api.entities({});
    await api.entities({ type: "", status: "draft" });
    expect(urls[0]).toBe("/api/entities?type=fact&limit=10");
    expect(urls[1]).toBe("/api/entities");
    expect(urls[2]).toBe("/api/entities?status=draft");
  });

  it("encodes ids that would otherwise break the path", async () => {
    const urls: string[] = [];
    configureApi({
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({});
      },
    });
    await api.persona("oidc:alex@example.test").catch(() => {});
    expect(urls[0]).toBe("/api/persona/oidc%3Aalex%40example.test");
  });
});
