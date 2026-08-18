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

/**
 * The id a group name becomes.
 *
 * ONE derivation, because two places mint group ids — the IdP mirror in `serve` and `refToId` in the
 * Backstage connector — and they disagreed: `platform_eng` from a claim became `group:platform-eng` while
 * the same team from a descriptor became `group:platform_eng`. Two records for one team means the `owns`
 * edge points at one and `member_of` at the other, so an owner page shows no members and the stale
 * routing's group fallback never reaches the group that owns the service. That is the parallel org chart
 * `refToId` says it exists to prevent, built by the two functions that were supposed to prevent it.
 *
 * Slugged rather than merely lowercased: an id with a space in it is unusable on a command line, and
 * `Payments Team` is a real group name.
 */
export function groupId(name: string): string {
  return `group:${slug(name)}`;
}

/** Same rule for a person minted from an external directory. */
export function personId(name: string): string {
  return `person:${slug(name)}`;
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
