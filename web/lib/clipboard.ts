"use client";

import { announce } from "./toast";

export async function copyText(value: string, message: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
  announce(message);
}
