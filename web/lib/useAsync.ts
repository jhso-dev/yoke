"use client";

// One loading hook for every screen. Without it every page repeats the same useEffect with the
// same three states and the same stale-response guard — and one of them eventually forgets the guard.

import { useCallback, useEffect, useState } from "react";

export interface Async<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** Re-run the loader — used after a mutation so the screen reflects what the server now says. */
  reload: () => void;
}

/**
 * Run `load` on mount and whenever `deps` change.
 *
 * The `alive` flag matters: a screen whose filter changes twice quickly gets two in-flight requests,
 * and without it the slower one can land last and overwrite the newer result.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // The caller owns the dependency list. `load` is excluded on purpose — callers pass an inline
  // closure, so including it would re-run on every render. `nonce` looks unnecessary to the
  // analyzer because it is only read through the closure's identity, but it is exactly what makes
  // reload() work.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explained directly above.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    load()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
