"use client";

import {
  ArrowRightIcon,
  GitBranchIcon,
  HandshakeIcon,
  KeyRoundIcon,
  SearchIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useT } from "../lib/i18n";

export default function Home() {
  const t = useT();
  return (
    <>
      <section className="home-hero">
        <div>
          <p className="eyebrow">{t.home.eyebrow}</p>
          <h1>{t.home.heading}</h1>
          <p className="lede">{t.home.lede}</p>
          <div
            className="home-context-flow"
            role="img"
            aria-label={t.home.flow.label}
          >
            <span>
              <ShieldCheckIcon />
              {t.home.flow.verified}
            </span>
            <ArrowRightIcon aria-hidden="true" />
            <strong>
              <HandshakeIcon />
              {t.home.flow.context}
            </strong>
            <ArrowRightIcon aria-hidden="true" />
            <span>
              <UsersRoundIcon />
              {t.home.flow.users}
            </span>
          </div>
          <Button asChild size="sm">
            <Link href="/collaboration/">
              <HandshakeIcon />
              {t.home.openCollaboration}
            </Link>
          </Button>
        </div>
        <span className="home-art">
          {/* biome-ignore lint/performance/noImgElement: static export forbids next/image in this app. */}
          <img
            className="home-icon home-icon-light"
            src="/yoke_hero.png"
            alt=""
          />
          {/* biome-ignore lint/performance/noImgElement: static export forbids next/image in this app. */}
          <img
            className="home-icon home-icon-dark"
            src="/yoke_hero_white.png"
            alt=""
          />
        </span>
      </section>
      <div className="home-grid">
        <Link className="home-tile home-tile-primary" href="/collaboration/">
          <HandshakeIcon />
          <strong>{t.home.cards.collaboration.title}</strong>
          <span>{t.home.cards.collaboration.body}</span>
        </Link>
        <Link className="home-tile" href="/review/">
          <ShieldCheckIcon />
          <strong>{t.home.cards.govern.title}</strong>
          <span>{t.home.cards.govern.body}</span>
        </Link>
        <Link className="home-tile" href="/inject/">
          <SearchIcon />
          <strong>{t.home.cards.inject.title}</strong>
          <span>{t.home.cards.inject.body}</span>
        </Link>
        <Link className="home-tile" href="/graph/">
          <GitBranchIcon />
          <strong>{t.home.cards.graph.title}</strong>
          <span>{t.home.cards.graph.body}</span>
        </Link>
        <Link className="home-tile" href="/tokens/">
          <KeyRoundIcon />
          <strong>{t.home.cards.share.title}</strong>
          <span>{t.home.cards.share.body}</span>
        </Link>
      </div>
    </>
  );
}
