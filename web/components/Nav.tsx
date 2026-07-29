"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Two groups, matching WEB-UI.md: the governance set acts on knowledge, the viewing set reads it. */
const LINKS = [
  { href: "/review/", label: "review" },
  { href: "/conflicts/", label: "conflicts" },
  { href: "/ontology/", label: "ontology" },
  { href: "/persona/", label: "persona" },
  { href: "/browse/", label: "browse" },
  { href: "/inject/", label: "inject" },
  { href: "/graph/", label: "graph" },
  { href: "/audit/", label: "audit" },
];

export function Nav() {
  const here = usePathname();
  return (
    <nav className="nav" aria-label="screens">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={here?.startsWith(l.href) ? "page" : undefined}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
