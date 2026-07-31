import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "../components/Header";
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
            <Header />
            <main>{children}</main>
            <ToastHost />
          </div>
        </LocaleProvider>
      </body>
    </html>
  );
}
