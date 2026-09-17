import { NextResponse, type NextRequest } from "next/server";

import { prefersMarkdown } from "./site/accept";
import { PAGE_MARKDOWN, type PublicPath } from "./site/content";

/**
 * Content negotiation for the public pages. An agent that asks for
 * `Accept: text/markdown` gets the page as Markdown; a browser gets the HTML
 * it always did. Unknown paths answer 404 in Markdown to the same asker. The
 * HTML side's `Vary: Accept` is set in next.config.ts, since Next writes its
 * own Vary over anything set here.
 *
 * The console (/bot), eve's routes (/eve), Next's own assets, and files never
 * pass through here: see the matcher.
 */

const MARKDOWN = "text/markdown; charset=utf-8";

const isPublicPath = (path: string): path is PublicPath => Object.hasOwn(PAGE_MARKDOWN, path);

function markdown(body: string, status = 200): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { "content-type": MARKDOWN, vary: "Accept", "x-robots-tag": status === 200 ? "all" : "noindex" },
  });
}

const NOT_FOUND = (path: string) => `# Not found

There is no page at \`${path}\`.

- Home: /
- What this site covers, for agents: /llms.txt
- Every page: /sitemap.xml
- Source and documentation: https://github.com/Shaivpidadi/eve-bot
`;

export function proxy(request: NextRequest): NextResponse {
  const path = request.nextUrl.pathname.replace(/\/+$/, "") || "/";
  if (prefersMarkdown(request.headers.get("accept"))) {
    if (isPublicPath(path)) return markdown(PAGE_MARKDOWN[path]);
    return markdown(NOT_FOUND(path), 404);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except the console, eve, Next internals, well-known, and files with an extension.
    "/((?!bot|eve|_next|\\.well-known|.*\\..*).*)",
  ],
};
