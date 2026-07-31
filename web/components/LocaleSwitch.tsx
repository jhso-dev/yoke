"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LOCALES, type Locale, useLocale } from "../lib/i18n";

/** The language control, in the top bar beside the credential state. */
export function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  return (
    <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
      {/* Sized to the longest label rather than to content, so switching language does not shift
          everything beside it in the top bar. */}
      <SelectTrigger aria-label="language" size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(LOCALES).map(([code, label]) => (
          <SelectItem key={code} value={code}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
