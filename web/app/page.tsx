"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The workbench opens on the review queue: promotion is the governance act with the most friction
 * to remove (WEB-UI.md calls it the core screen). */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/review/");
  }, [router]);
  return <p className="muted">opening the review queue…</p>;
}
