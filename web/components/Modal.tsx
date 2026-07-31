"use client";

import { useEffect, useRef } from "react";

/**
 * A modal, on the native `<dialog>` element.
 *
 * `showModal()` brings focus trapping, Esc-to-close, inertness of the page behind, and a `::backdrop`
 * to style — all of it browser behaviour we would otherwise be hand-rolling and getting subtly wrong.
 * The one thing it does not do is close on an outside click, so that is the only behaviour added.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Guarded both ways: showModal() on an already-open dialog throws, and close() on a closed one
    // fires a spurious `close` event that would bounce straight back through onClose.
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A native listener rather than an onClick prop. The dialog IS the backdrop as far as events go —
    // the backdrop is not a separate element that could be the target — so this is a click on the
    // dialog whose coordinates fall outside its box, not a click on a child. As a JSX handler it also
    // reads as an interactive element needing a keyboard equivalent, and there is no keyboard way to
    // "click outside": Esc is that, and <dialog> already handles it.
    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const outside =
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom;
      // A click with no coordinates is a keyboard-activated button inside the dialog: Enter on a
      // submit button reports 0,0, which is outside the box and would otherwise close the form
      // the moment it was submitted.
      if (outside && (e.clientX || e.clientY)) el.close();
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, []);

  return (
    // Esc, the close button and the backdrop all route through the element's own `close` event, so
    // the parent's state cannot drift from the element's — the browser can close this without React.
    <dialog ref={ref} onClose={onClose} aria-label={title}>
      <div className="modal-head">
        <strong>{title}</strong>
        <button type="button" onClick={() => ref.current?.close()}>
          close
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
