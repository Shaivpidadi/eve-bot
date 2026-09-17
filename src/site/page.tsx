import type { Metadata } from "next";

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

export function TextPageView({ page }: { page: TextPage }) {
  return (
    <main className="landing page">
      <header className="landing-head">
        <a className="page-back" href="/">
          ← {SITE.name}
        </a>
        <h1>{page.title}</h1>
      </header>
      <article className="page-body">
        {page.paragraphs.map((text) => (
          <p key={text.slice(0, 40)}>{linkify(text)}</p>
        ))}
      </article>
      <footer className="landing-foot">
        <a href="/about">About</a>
        <span aria-hidden="true">·</span>
        <a href="/contact">Contact</a>
        <span aria-hidden="true">·</span>
        <a href="/privacy">Privacy</a>
        <span aria-hidden="true">·</span>
        <a href={SITE.repo}>Source on GitHub</a>
      </footer>
    </main>
  );
}

/** Turns bare https URLs in prose into links, leaving trailing punctuation outside. */
function linkify(text: string) {
  const parts = text.split(/(https:\/\/[^\s]+?)(?=[.,;)]?(?:\s|$))/);
  return parts.map((part, i) =>
    /^https:\/\//.test(part) ? (
      <a key={i} href={part}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
