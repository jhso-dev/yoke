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
 * unrepresentable — and `description` stays available for the sentence that used to sit above each
 * form. Screens pass `open`/`onClose` and their fields; nothing else.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent closeLabel={t.common.close}>
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
