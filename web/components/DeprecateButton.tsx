"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import type { Knowledge } from "../lib/types";
import { ErrorBanner } from "./ErrorBanner";
import { Modal } from "./Modal";

/**
 * Retiring knowledge, with the one thing a retired record cannot answer for itself.
 *
 * A deprecated record raised exactly one question — why — and the status was on the record while the
 * reason was nowhere: `deprecate` took ids, an actor and an instant, and nothing else. So the reader
 * who found it later got "deprecated" and had to go ask a person, if they could work out which one.
 *
 * The reason is asked for here and stored on the audit ROW, never on the record: verify and deprecate
 * change status, never knowledge content (core/lifecycle.ts), and the reason is a property of the act
 * rather than of the thing. The retired record's own screen reads it back.
 *
 * Optional, not required. Retiring is reversible — verify promotes it again — so a wall in front of a
 * recoverable act would only teach people to type "x". The dialog says who the sentence is for
 * instead, which is the argument for writing one.
 */
export function DeprecateButton({
  ids,
  disabled,
  label,
  onDone,
  onOpen,
  onClose,
}: {
  ids: string[];
  disabled?: boolean;
  /** The button's own wording; the count belongs to the caller's toolbar. */
  label: string;
  onDone: (downstream: Knowledge[]) => void;
  /** For a screen that must refuse a SECOND retire while this one is being written — the conflicts
   * pair, where retiring both halves is the outcome the screen exists to prevent. */
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { downstream } = await api.deprecate(ids, reason);
      setReason("");
      setOpen(false);
      onDone(downstream);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        disabled={disabled}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Modal
        open={open}
        title={t.common.deprecate}
        description={t.retire.why(ids.length)}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        holdsForm
      >
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="retire-reason">
              {t.retire.reason}{" "}
              <span className="text-muted-foreground font-normal">
                {t.retire.optional}
              </span>
            </Label>
            <Textarea
              id="retire-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t.retire.placeholder}
              rows={3}
              autoFocus
            />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? t.common.deprecating : t.common.deprecate}
            </Button>
            <span className="text-muted-foreground text-xs">
              {t.retire.kept}
            </span>
          </div>
          <ErrorBanner error={error} />
        </form>
      </Modal>
    </>
  );
}
