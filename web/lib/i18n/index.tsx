"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { en } from "./en";
import { ko } from "./ko";
import { chooseLocale, LOCALES, type Locale, preferredLocale } from "./locale";

export { chooseLocale, LOCALES, type Locale, preferredLocale };

const DICTS = { en, ko };
const STORAGE_KEY = "yoke.locale";

/**
 * Locale is client state, not a route.
 *
 * The web tier is `output: 'export'` — a static bundle the CLI's own server hands out. Per-locale
 * routing would mean `generateStaticParams` and a full copy of all thirteen routes per language,
 * doubling what ships so that a preference can live in a URL nobody types. Reading the preference in
 * the browser costs one `useState` and keeps the bundle one copy.
 *
 * The trade, stated because it is visible: the prerendered HTML is English, so a Korean reader sees
 * one English paint before the effect below swaps it. Committing a locale at build time is the only
 * way to avoid that, and it is the thing static export cannot do without shipping both copies.
 */
const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
}>({ locale: "en", setLocale: () => {} });

/** A stored choice wins; otherwise the browser's own language preference decides. Falling straight
 * to English would put an English UI in front of a Korean reader while the Korean catalog sits
 * complete behind a switcher they have to find first. */
function detect(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored !== null) return chooseLocale(stored);
  return preferredLocale(navigator.languages ?? [navigator.language]);
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Starts English to match the prerendered HTML exactly. Reading storage during the first render
  // would make the client's tree disagree with the server's and produce a hydration error.
  const [locale, set] = useState<Locale>("en");

  useEffect(() => {
    const found = detect();
    if (found !== "en") set(found);
    document.documentElement.lang = found;
  }, []);

  const setLocale = (l: Locale) => {
    set(l);
    localStorage.setItem(STORAGE_KEY, l);
    // The attribute is not decoration: it is what a screen reader picks a voice from, and what a
    // browser offers to translate from.
    document.documentElement.lang = l;
  };

  return (
    <LocaleContext value={{ locale, setLocale }}>{children}</LocaleContext>
  );
}

/** The dictionary for the active locale. `t.review.heading`, `t.audit.shown(3, 10)`. */
export function useT() {
  return DICTS[useContext(LocaleContext).locale];
}

export function useLocale() {
  return useContext(LocaleContext);
}
