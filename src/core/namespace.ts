// namespace — logical multi-tenancy (PLAN-V2 10.1, ENTERPRISE.md multi-tenancy).
// A namespace is a nullable string; null/undefined/"" all mean the default (shared)
// namespace that holds every v0.1 row. This is the ONLY module that owns namespace
// semantics: everywhere else a namespace travels as an explicit parameter and entity
// ids stay opaque (ENTERPRISE.md constraint 1 — never parse a namespace out of an id).

/** Canonical form: undefined | null | "" → null (the default/shared namespace). */
export function normalizeNs(ns?: string | null): string | null {
  return ns === undefined || ns === null || ns === "" ? null : ns;
}

/** Front-tier precedence: explicit flag > YOKE_NS env > default (null). */
export function resolveNs(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string | null {
  return normalizeNs(flag ?? env.YOKE_NS);
}
