import type { Metadata } from "next";

import { SITE } from "../site/content";
import { PAGE } from "../site/page";

export const metadata: Metadata = { title: `Not found · ${SITE.name}`, robots: { index: false } };

/** The HTML 404. Agents that ask for Markdown get the same from `src/proxy.ts`. */
export default function NotFound() {
  return (
    <main className={PAGE}>
      <header className="flex flex-col items-start gap-3">
        <h1 className="m-0 text-[28px] font-[650] tracking-[-0.01em]">Not found</h1>
        <p className="m-0 max-w-[620px] text-[15px] leading-normal text-muted-foreground">There is no page here.</p>
      </header>
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-[18px] text-sm leading-normal [&_a]:text-foreground [&_a]:underline">
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
