"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "../lib/api";
import { useT } from "../lib/i18n";

/** Turns a failure into something actionable: a 403 names the scope and the command that grants it,
 * a 409 repeats the server's read-replica wording verbatim, and a transport failure says what
 * actually happened instead of handing over the browser's own untranslated "Failed to fetch".
 *
 * `onRetry` is optional but should be passed wherever the caller has a `reload` to give: without it
 * a failed screen is a dead end whose only exit is the browser's reload button, which throws away
 * every filter in the URL along with the error. */
export function ErrorBanner({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const t = useT();
  if (!error) return null;
  let kind: "error" | "warn" = "error";
  let text = error instanceof Error ? error.message : String(error);
  // Not an ApiError means the request never reached the server (or its answer was unreadable), so
  // there is no server message to show — only the browser's, which is English on every locale and
  // says nothing a reader can act on.
  if (!(error instanceof ApiError)) text = t.common.requestFailed;
  if (error instanceof ApiError && error.forbidden) {
    kind = "warn";
    text = `${text} — ${t.errors.forbiddenHint}`;
  }
  if (error instanceof ApiError && error.status === 409) kind = "warn";
  return (
    <Alert variant={kind}>
      {text}
      {onRetry && (
        <>
          {" "}
          <Button
            type="button"
            variant="secondary"
            size="text"
            className="underline"
            onClick={onRetry}
          >
            {t.common.retry}
          </Button>
        </>
      )}
    </Alert>
  );
}
