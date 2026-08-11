"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../lib/i18n";

/**
 * The app's one modal shape, on shadcn's Dialog (Radix underneath).
 *
 * Kept as a wrapper rather than letting every screen assemble Dialog + Content + Header itself: the
 * title is not optional here — a dialog with no accessible name is the defect this indirection makes
 * unrepresentable — and `description` carries the explanatory sentence a form needs above its
 * fields. Screens pass `open`/`onClose` and their fields; nothing else.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  holdsForm = false,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /**
   * Set when the dialog contains a form. A click that lands outside then does NOT dismiss it: with
   * Radix's default, one stray click anywhere on the page threw away every field someone had typed,
   * with no confirmation and no way back. Esc and the close button still work, because those are
   * deliberate — a misplaced click is not.
   */
  holdsForm?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        closeLabel={t.common.close}
        onInteractOutside={holdsForm ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
