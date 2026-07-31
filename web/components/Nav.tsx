"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "../lib/i18n";

/** Two groups, matching WEB-UI.md: the governance set acts on knowledge, the viewing set reads it. */
// href and key only. The label is looked up per render so switching language re-labels the nav
// without the route table knowing a language exists.
const LINKS = [
  { href: "/review/", key: "review" },
  { href: "/conflicts/", key: "conflicts" },
  { href: "/ontology/", key: "ontology" },
  { href: "/persona/", key: "persona" },
  { href: "/collaboration/", key: "collaboration" },
  { href: "/browse/", key: "browse" },
  { href: "/inject/", key: "inject" },
  { href: "/graph/", key: "graph" },
  { href: "/audit/", key: "audit" },
  { href: "/tokens/", key: "tokens" },
] as const;

export function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const here = usePathname();
  const t = useT();
  return (
    <nav className="nav" aria-label={t.nav.screens}>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={here?.startsWith(l.href) ? "page" : undefined}
          onClick={onNavigate}
        >
          {t.nav[l.key]}
        </Link>
      ))}
    </nav>
  );
}
