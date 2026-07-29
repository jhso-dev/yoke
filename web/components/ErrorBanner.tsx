"use client";

import { ApiError } from "../lib/api";

/** Turns a failure into something actionable: a 403 names the scope and the command that grants it,
 * a 409 repeats the server's read-replica wording verbatim. */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  let kind = "error";
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError && error.forbidden) {
    kind = "warn";
    text = `${text} — this credential lacks the scope for that action. Mint one with: yoke token create --scopes read,verify`;
  }
  if (error instanceof ApiError && error.status === 409) kind = "warn";
  return (
    <div className="banner" data-kind={kind} role="alert">
      {text}
    </div>
  );
}
