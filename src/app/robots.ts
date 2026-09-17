import type { MetadataRoute } from "next";

import { SITE } from "../site/content";

/** Crawl the front door; the console and the agent's routes are private. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/bot", "/eve"] }],
    sitemap: `${SITE.origin}/sitemap.xml`,
  };
}
