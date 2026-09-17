import { LLMS_TXT } from "../../site/content";

/** What this site is and when an agent should reach for it: https://llmstxt.org */
export function GET(): Response {
  return new Response(LLMS_TXT, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
