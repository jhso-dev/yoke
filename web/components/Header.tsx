"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "../lib/i18n";
import { AuthGate } from "./AuthGate";
import { LocaleSwitch } from "./LocaleSwitch";
import { Nav } from "./Nav";
import { ThemeSwitch } from "./ThemeSwitch";

export function Header() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar" data-menu-open={open || undefined}>
      <Link className="brand" href="/" onClick={() => setOpen(false)}>
        YOKE
      </Link>
      <Button
        className="mobile-menu-toggle"
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={open ? t.nav.closeMenu : t.nav.openMenu}
        aria-controls="site-navigation"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <XIcon /> : <MenuIcon />}
      </Button>
      <div className="topbar-content" id="site-navigation">
        <Nav onNavigate={() => setOpen(false)} />
        <div className="topbar-end">
          <AuthGate />
          <ThemeSwitch />
          <LocaleSwitch />
        </div>
      </div>
    </header>
  );
}
