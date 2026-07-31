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
      timer = window.setTimeout(() => setMessage(""), 1600);
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
