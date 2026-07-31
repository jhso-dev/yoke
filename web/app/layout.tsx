import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthGate } from "../components/AuthGate";
import { LocaleSwitch } from "../components/LocaleSwitch";
import { Nav } from "../components/Nav";
import { LocaleProvider } from "../lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "yoke — governance workbench",
  description:
    "Review, verify and audit the knowledge your AI agents are allowed to receive.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // lang starts as the prerendered locale and is corrected on mount by LocaleProvider.
    <html lang="en">
      <body>
        <LocaleProvider>
          <div className="shell">
            <header className="topbar">
              <span className="brand">YOKE</span>
              <Nav />
              {/* Language last: it is the least-used control here and the one a reader looks for
                  at the edge, while the credential state is what they scan on arrival. */}
              <div className="topbar-end">
                <AuthGate />
                <LocaleSwitch />
              </div>
            </header>
            <main>{children}</main>
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
