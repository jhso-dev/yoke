// shadcn's class merger: clsx resolves conditionals, tailwind-merge resolves conflicts so a caller's
// `className` beats a component's own default instead of both landing in the class list.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
