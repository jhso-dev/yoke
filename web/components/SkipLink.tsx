"use client";

import { useT } from "../lib/i18n";

/**
 * The first tab stop on every page.
 *
 * A client component only so the label can be translated — a hardcoded "Skip to content" would be
 * English on the Korean UI, and this is the one control a keyboard reader meets before anything
 * else. Visible only while focused, which is the whole convention: it costs sighted readers nothing
 * and saves everyone else re-tabbing the fourteen controls in the header on every navigation.
 */
export function SkipLink() {
  const t = useT();
  return (
    <a href="#main" className="skip-link">
      {t.common.skipToContent}
    </a>
  );
}
