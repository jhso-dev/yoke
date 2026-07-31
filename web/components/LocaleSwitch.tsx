"use client";

import { LOCALES, type Locale, useLocale } from "../lib/i18n";

/**
 * The language control, in the top bar beside the actor.
 *
 * A plain `<select>` rather than shadcn's: it sits in the chrome next to the credential state, and
 * the Radix version renders a portal with a focus scope — a lot of machinery for two options that
 * fit in a native control the OS already knows how to present on a phone.
 */
export function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  return (
    <select
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label="language"
      className="bg-card text-foreground border-border rounded-md border px-2 py-1 text-xs"
    >
      {Object.entries(LOCALES).map(([code, label]) => (
        <option key={code} value={code}>
          {label}
        </option>
      ))}
    </select>
  );
}
