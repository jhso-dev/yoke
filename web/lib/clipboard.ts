"use client";

export async function copyText(value: string, message: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
  window.dispatchEvent(new CustomEvent("yoke:toast", { detail: { message } }));
}
