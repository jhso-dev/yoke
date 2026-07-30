// Instants as a person reads them.
//
// The store's vocabulary is ISO UTC and stays that way: `2026-07-30T07:43:58.846Z` IS the audit fact,
// it is what a citation carries, and it is what the CLI prints. This module is display only — nothing
// here changes a stored or transmitted value.

/**
 * Fixed notation, the viewer's zone.
 *
 * The locale is pinned to `en-CA` while the ZONE comes from the viewer, and that split is the point.
 * A locale-formatted date changes field order and width per browser (`2026. 07. 30.`, `30/07/2026`),
 * which breaks a column of them and makes two rows hard to compare; the ISO-shaped date is also the
 * vocabulary the rest of the product speaks. So the instant is localized, the notation is not.
 *
 * `timeZoneName` is not decoration. A bare `16:43` that is silently not UTC is a worse ambiguity than
 * the raw `Z` string it replaced, in a tool whose entire job is answering when something happened.
 */
const shape = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // h23 rather than hour12:false — the latter renders midnight as hour 24 on some engines.
  hourCycle: "h23",
  timeZoneName: "short",
});

/**
 * `2026-07-30 16:43:58 GMT+9` — the same instant, where the reader is sitting.
 *
 * Seconds are kept because an audit trail can hold two rows in one minute and they must not read as
 * the same moment. Milliseconds are dropped: noise in every column that showed them, and still one
 * hover away on the element.
 */
export function localTime(iso: string): string {
  const d = new Date(iso);
  // Never swallow a value we cannot parse: the raw string is more use to a reader than "Invalid Date",
  // and a malformed timestamp is something they should see rather than something we should hide.
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const part of shape.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}
