import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthGate } from "../components/AuthGate";
import { Nav } from "../components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "yoke — governance workbench",
  description:
    "Review, verify and audit the knowledge your AI agents are allowed to receive.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="brand">YOKE</span>
            <Nav />
            <AuthGate />
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
