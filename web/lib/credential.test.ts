import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCredential,
  getCredential,
  setCredential,
  takeCredentialFromUrl,
} from "./credential";

// vitest runs in node, so `window` is absent unless a test provides it — which makes this the
// natural place to pin the SSR guard: static export prerenders these modules in node at build time,
// and a bare `window.sessionStorage` would crash the build rather than a page.
const realWindow = (globalThis as { window?: unknown }).window;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function fakeWindow(href: string) {
  let current = href;
  (globalThis as { window?: unknown }).window = {
    location: {
      get href() {
        return current;
      },
    },
    sessionStorage: fakeStorage(),
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        current = `https://yoke.test${next}`;
      },
    },
  };
  return { href: () => current };
}

beforeEach(() => clearCredential());
afterEach(() => {
  if (realWindow === undefined)
    delete (globalThis as { window?: unknown }).window;
  clearCredential();
});

describe("credential", () => {
  it("returns null with no window (build-time prerender) instead of throwing", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(getCredential()).toBeNull();
    // Writing must be a no-op too, not a crash.
    expect(() => setCredential("x")).not.toThrow();
  });

  it("round-trips through sessionStorage and clears on demand", () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: fakeStorage(),
    };
    setCredential("tok-1");
    expect(getCredential()).toBe("tok-1");
    clearCredential();
    expect(getCredential()).toBeNull();
  });

  it("keeps working from memory when storage is unavailable (private mode)", () => {
    (globalThis as { window?: unknown }).window = {
      get sessionStorage(): Storage {
        throw new Error("storage disabled");
      },
    };
    setCredential("tok-2");
    // A non-persistent session is degraded but usable; a thrown error would break the whole app.
    expect(getCredential()).toBe("tok-2");
  });

  it("accepts a shared URL token and removes it from the address bar", () => {
    const w = fakeWindow("https://yoke.test/persona/?id=p1&token=tok-url");
    expect(takeCredentialFromUrl()).toBe("tok-url");
    expect(getCredential()).toBe("tok-url");
    expect(w.href()).toBe("https://yoke.test/persona/?id=p1");
  });

  it("also accepts hash tokens so the token need not hit server logs", () => {
    const w = fakeWindow("https://yoke.test/graph/#token=tok-hash&scope=x");
    expect(takeCredentialFromUrl()).toBe("tok-hash");
    expect(getCredential()).toBe("tok-hash");
    expect(w.href()).toBe("https://yoke.test/graph/#scope=x");
  });
});
