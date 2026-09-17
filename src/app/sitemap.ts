import type { MetadataRoute } from "next";

import { PAGES, SITE } from "../site/content";

/** The public pages, and nothing behind the console. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return PAGES.map((path) => ({
    url: `${SITE.origin}${path === "/" ? "" : path}`,
    lastModified,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
