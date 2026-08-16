"use client";

/**
 * Raise the one-line status toast (components/ToastHost).
 *
 * An event rather than a context: the toast has one host mounted in the shell and every caller is a
 * leaf that wants to say one sentence, so threading a provider through them buys nothing.
 */
export function announce(message: string): void {
  window.dispatchEvent(new CustomEvent("yoke:toast", { detail: { message } }));
}
