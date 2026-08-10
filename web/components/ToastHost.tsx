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

  if (!message) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}
