import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AuthGate } from "../components/AuthGate";
import { LocaleSwitch } from "../components/LocaleSwitch";
import { Nav } from "../components/Nav";
import { ThemeSwitch } from "../components/ThemeSwitch";
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // lang starts as the prerendered locale and is corrected on mount by LocaleProvider.
    <html lang="en">
      <body>
        <LocaleProvider>
          <div className="shell">
            <header className="topbar">
              <Link className="brand" href="/">
                YOKE
              </Link>
              <Nav />
              {/* Language last: it is the least-used control here and the one a reader looks for
                  at the edge, while the credential state is what they scan on arrival. */}
              <div className="topbar-end">
                <AuthGate />
                <ThemeSwitch />
                <LocaleSwitch />
              </div>
            </header>
            <main>{children}</main>
            <ToastHost />
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
