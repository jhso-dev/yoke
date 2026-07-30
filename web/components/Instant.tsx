"use client";

import { localTime } from "../lib/time";

/**
 * A moment in time, shown the way an id is shown: readable here, exact one hover away.
 *
 * `2026-07-30T07:43:58.846Z` is the right thing to store and the wrong thing to read — nobody knows
 * what hour that was where they were sitting, and the milliseconds are noise in a column. So the text
 * is the viewer's own zone and the native `<time dateTime>` keeps the ISO instant in the DOM, where a
 * machine, a copy, and a hover can all still reach it.
 *
 * A component rather than a call at each site for the same reason `<Actor>` and `<Citation>` are: the
 * site that forgets the exact value loses it silently, and that value is the audit trail's whole point.
 */
export function Instant({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {localTime(iso)}
    </time>
  );
}
