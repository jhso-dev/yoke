"use client";

import { useEffect, useState } from "react";

export function ToastHost() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    let timer = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      if (!detail?.message) return;
      window.clearTimeout(timer);
      setMessage(detail.message);
      // Time to read scales with what there is to read: "copied" needs a blink, a duplicate
      // warning naming three records needs a sentence's worth. Capped so a mistake in a message
      // cannot park a toast on screen.
      timer = window.setTimeout(
        () => setMessage(""),
        Math.min(7000, Math.max(1600, 600 + detail.message.length * 55)),
      );
    };
    window.addEventListener("yoke:toast", onToast);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("yoke:toast", onToast);
    };
  }, []);

  // The live region is ALWAYS mounted and only its text changes. Returning null when idle meant the
  // region was inserted in the same mutation as its content, which assistive tech announces
  // unreliably — so every outcome that goes through `announce()` (created, duplicates found, copied,
  // nothing new to expand) was silent for a screen-reader user much of the time. The wrapper is
  // inert when empty: no box, no space, nothing to click.
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}
