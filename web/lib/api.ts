// The only place web/ calls fetch.
//
// One call site means credential attachment and 401 handling cannot be forgotten by a screen, and
// `fetchImpl` is injectable so both are unit-testable without a browser — the convention the
// opensearch adapter and the slack connector already use in this repo.

import { clearCredential, getCredential } from "./credential";
import type {
  AuditEntry,
  ConflictPair,
  CreatedToken,
  Edge,
  EntityDetail,
  GraphData,
  InjectPreview,
  Knowledge,
  Meta,
  Page,
  Persona,
  SearchResult,
  StaleQueue,
  TokenInfo,
  TypeDef,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** True when the credential is missing, wrong, or revoked — the caller should send us to login. */
  get unauthenticated(): boolean {
    return this.status === 401;
  }
  /** True when authenticated but the token's scopes do not cover this action. */
  get forbidden(): boolean {
    return this.status === 403;
  }
}

type Fetch = typeof fetch;

let fetchImpl: Fetch = (...args) => fetch(...args);
let onUnauthorized: (() => void) | null = null;

/** Test seam + the app's 401 hook (set once by the shell so every screen inherits it). */
export function configureApi(opts: {
  fetchImpl?: Fetch;
  onUnauthorized?: () => void;
}): void {
  if (opts.fetchImpl) fetchImpl = opts.fetchImpl;
  if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cred = getCredential();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (cred) headers.authorization = `Bearer ${cred}`;
  const res = await fetchImpl(path, { ...init, headers });
  if (res.status === 401) {
    // A revoked or expired credential must not linger and keep failing silently.
    clearCredential();
    onUnauthorized?.();
    throw new ApiError(401, "not authenticated");
  }
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const api = {
  meta: () => request<Meta>("/api/meta"),
  review: () => request<Knowledge[]>("/api/review"),
  /** The stale queue — verified records past their TTL. A different return shape from `review()` on
   * purpose: this one carries how much of the corpus the walk examined. */
  stale: (p: { type?: string; limit?: number; after?: string } = {}) =>
    request<StaleQueue>(`/api/review${qs({ ...p, stale: 1 })}`),
  conflicts: () => request<ConflictPair[]>("/api/conflicts"),
  ontology: () => request<TypeDef[]>("/api/ontology"),
  persona: (id: string) =>
    request<Persona>(`/api/persona/${encodeURIComponent(id)}`),
  entities: (p: {
    type?: string;
    status?: string;
    limit?: number;
    after?: string;
  }) => request<Page<Knowledge>>(`/api/entities${qs(p)}`),
  search: (p: { q: string; type?: string; status?: string; limit?: number }) =>
    request<SearchResult>(`/api/search${qs(p)}`),
  entity: (id: string) =>
    request<EntityDetail>(`/api/entity/${encodeURIComponent(id)}`),
  inject: (p: {
    q?: string;
    scope?: string;
    includeDraft?: boolean;
    limit?: number;
    /** An ISO instant: what this query would have injected then. */
    asOf?: string;
  }) => request<InjectPreview>(`/api/inject${qs(p)}`),
  graph: (p: { limit?: number; scope?: string; depth?: number }) =>
    request<GraphData>(`/api/graph${qs(p)}`),
  audit: (p: { since?: string; until?: string; limit?: number }) =>
    request<{ items: AuditEntry[]; limit: number }>(`/api/audit${qs(p)}`),
  tokens: () => request<TokenInfo[]>("/api/tokens"),
  createToken: (p: { name: string; scopes: string[] }) =>
    request<CreatedToken>("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
  revokeToken: (name: string) =>
    request<{ name: string; revoked: true }>(
      `/api/tokens/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  verify: (ids: string[]) =>
    request<Knowledge[]>("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  /** Retiring knowledge also answers what rests on it (`derived_from`, v5.8) — the same two halves
   * `yoke deprecate` prints, since retiring a record is not a repair unless the records built on it can
   * be found. `downstream` is `[]` when nothing declared a basis, never absent. */
  deprecate: (ids: string[], reason?: string) =>
    request<{ deprecated: Knowledge[]; downstream: Knowledge[] }>(
      "/api/deprecate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The reason rides on the governance act, not on the record: it is read back on the retired
        // record's own screen, which is where the question gets asked.
        body: JSON.stringify({ ids, ...(reason?.trim() ? { reason } : {}) }),
      },
    ),
  /** Create a record. It enters as a draft like any other — the gate does not care which adapter
   * called it — and comes back with whatever duplicates the gate found, so a form can show them. */
  create: (p: {
    type: string;
    attributes: Record<string, string | number | boolean | string[]>;
    scope?: string;
  }) =>
    request<
      Knowledge & {
        duplicates: Knowledge[];
        /** Why `duplicates` is empty. `"skipped"` means nothing was compared — no embedding
         * provider — which is a different fact from "nothing similar was found". */
        duplicateDetection: "embedding" | "skipped";
      }
    >("/api/entity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
  /** Record a relation. `yoke link` in the browser; direction is the caller's to get right.
   * `existed` is true when that edge was already recorded and nothing was stored — a relation's
   * identity is (type, from, to), so a second link of the same pair is a no-op. */
  link: (p: {
    from: string;
    type: string;
    to: string;
    attributes?: Record<string, string | string[]>;
  }) =>
    request<Edge & { existed: boolean }>("/api/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
  /** `yoke ontology add-type`. Append-only per name, so an existing name is a migration. */
  addType: (def: TypeDef) =>
    request<TypeDef>("/api/ontology", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ def }),
    }),
  /** `yoke backfill` — re-derive authorship edges. Idempotent; a second run creates nothing. */
  backfill: () =>
    request<{ scanned: number; created: number }>("/api/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  /** `yoke rename-type` — the declaration and every stored row, including history. */
  renameType: (p: { from: string; to: string }) =>
    request<{ from: string; to: string; rows: number }>("/api/rename-type", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }),
};
