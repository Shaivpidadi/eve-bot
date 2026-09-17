import type { Metadata } from "next";

import { SITE } from "../site/content";

export const metadata: Metadata = { title: `Not found · ${SITE.name}`, robots: { index: false } };

/** The HTML 404. Agents that ask for Markdown get the same from `src/proxy.ts`. */
export default function NotFound() {
  return (
    <main className="landing page">
      <header className="landing-head">
        <h1>Not found</h1>
        <p>There is no page here.</p>
      </header>
      <ul className="page-links">
        <li>
          <a href="/">Home</a>
        </li>
        <li>
          <a href="/bot">The console, if Bot runs here</a>
        </li>
        <li>
          <a href="/llms.txt">What this site covers, for agents</a>
        </li>
        <li>
          <a href={SITE.repo}>Source and documentation</a>
        </li>
      </ul>
    </main>
  );
}
