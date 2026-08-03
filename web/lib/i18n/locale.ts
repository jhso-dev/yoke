// The react-free half of i18n: which locales exist, and which one a stored string means.
//
// Split out of index.tsx because that file is JSX and a test importing it needs React resolvable.
// The root vitest suite runs these web tests with only the ROOT node_modules installed — `web/`'s own
// install happens as a side effect of `typecheck:web`, which the windows CI job skips. So a `.tsx`
// import here failed on win32 only. Pure functions belong outside the provider anyway; index.tsx
// re-exports all three, so no caller had to change.

export const LOCALES = { en: "English", ko: "한국어" } as const;
export type Locale = keyof typeof LOCALES;

/** English unless the stored value is exactly a locale we ship — "ko-KR" is not "ko". */
export function chooseLocale(stored: string | null): Locale {
  if (stored === "en" || stored === "ko") return stored;
  return "en";
}
