import type { Metadata } from "next";
import { Fragment } from "react";

import { cn } from "@/lib/utils";


import { SITE } from "./content";

/** One plain page of prose: the trust pages share this shape. */
export interface TextPage {
  title: string;
  paragraphs: readonly string[];
}

export function textPageMetadata(path: string, page: TextPage, description: string): Metadata {
  return {
    title: `${page.title} · ${SITE.name}`,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", url: path, title: page.title, description, siteName: SITE.name, images: ["/apple-icon.png"] },
  };
}

/** The public pages' column: the landing at 920px, the prose pages narrower. */
export const LANDING =
  "mx-auto flex max-w-[920px] flex-col gap-9 px-5 pt-14 pb-10 text-foreground max-[720px]:gap-7 max-[720px]:px-4 max-[720px]:pt-9 max-[720px]:pb-8";
export const PAGE = cn(LANDING, "max-w-[680px] gap-6");

/** The links along the bottom of a public page, dot-separated. */
export function SiteFooter({ links, trailing }: { links: readonly { href: string; label: string }[]; trailing?: string }) {
  return (
    <footer className="flex flex-wrap gap-2.5 border-t border-border pt-2 text-[12.5px] text-faint">
      {links.map((link, index) => (
        <Fragment key={link.href}>
          {index === 0 ? null : <span aria-hidden="true">·</span>}
          <a className="text-muted-foreground no-underline hover:text-foreground hover:underline" href={link.href}>
            {link.label}
          </a>
        </Fragment>
      ))}
      {trailing === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span>{trailing}</span>
        </>
      )}
    </footer>
  );
}

export function TextPageView({ page }: { page: TextPage }) {
  return (
    <main className={PAGE}>
      <header className="flex flex-col items-start gap-3">
        <a className="text-[13px] text-muted-foreground no-underline hover:text-foreground" href="/">
          ← {SITE.name}
        </a>
        <h1 className="m-0 text-[28px] font-[650] tracking-[-0.01em]">{page.title}</h1>
      </header>
      <article className="flex flex-col gap-3.5">
        {page.paragraphs.map((text) => (
          <p key={text.slice(0, 40)} className="m-0 text-[15px] leading-relaxed text-foreground">
            {linkify(text)}
          </p>
        ))}
      </article>
      <SiteFooter
        links={[
          { href: "/about", label: "About" },
          { href: "/contact", label: "Contact" },
          { href: "/privacy", label: "Privacy" },
          { href: SITE.repo, label: "Source on GitHub" },
        ]}
      />
    </main>
  );
}

/** Turns bare https URLs in prose into links, leaving trailing punctuation outside. */
function linkify(text: string) {
  const parts = text.split(/(https:\/\/[^\s]+?)(?=[.,;)]?(?:\s|$))/);
  return parts.map((part, i) =>
    /^https:\/\//.test(part) ? (
      <a key={i} className="break-words text-foreground underline decoration-faint" href={part}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
