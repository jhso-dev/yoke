import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "../components/Header";
import { SkipLink } from "../components/SkipLink";
import { ToastHost } from "../components/ToastHost";
import { LocaleProvider } from "../lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "yoke — governance workbench",
  description:
    "Review, verify and audit the knowledge your AI agents are allowed to receive.",
  icons: {
    icon: "/icon.svg",
  },
};

/**
 * Two dark switches have to agree, and only one of them is CSS.
 *
 * theme.css keys its tokens off `prefers-color-scheme` and `[data-theme]`, while Tailwind's `dark:`
 * variant keys off a `.dark` class that ThemeSwitch adds in an effect — i.e. after hydration.
 * Without this, an OS-dark visitor gets dark TOKENS on the first paint with every `dark:` utility
 * still off (a destructive button at full-strength light-theme red, 2.77:1 against white, and an
 * inert checked-checkbox override), and anyone who pinned a theme against their OS gets a full flash
 * of the other one.
 *
 * This runs before first paint and stamps both signals from the same stored value, so CSS and
 * utilities cannot disagree. It is inline and blocking on purpose — that is the only position from
 * which a flash is preventable — and it stays a few lines so it can be read at a glance.
 */
const THEME_BOOTSTRAP = `try{var s=localStorage.getItem("yoke.theme");var p=s==="light"||s==="dark";var r=document.documentElement;if(p)r.dataset.theme=s;var d=s==="dark"||(!p&&matchMedia("(prefers-color-scheme: dark)").matches);r.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // lang starts as the prerendered locale and is corrected on mount by LocaleProvider.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the pre-paint theme stamp — see above. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <LocaleProvider>
          <div className="shell">
            <SkipLink />
            <Header />
            <main id="main">{children}</main>
            <ToastHost />
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
