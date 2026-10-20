import type { MetadataRoute } from "next";

import { SITE } from "../../../site/content";

/**
 * The console as an installable app (docs/plan/notifications.md, N1): its own
 * window, icon and name, scoped to `/bot` so the public site stays a website.
 * Served here rather than as `app/manifest.ts`, which would make the whole
 * site the app; `app/bot/layout.tsx` links it with credentials, so a
 * deployment behind Vercel Authentication can still be installed.
 */
export const dynamic = "force-static";

const MANIFEST: MetadataRoute.Manifest = {
  id: "/bot",
  name: SITE.name,
  short_name: "EVE Bot",
  description: SITE.tagline,
  start_url: "/bot",
  scope: "/bot",
  display: "standalone",
  background_color: "#111113",
  theme_color: "#111113",
  icons: [
    { src: "/bot/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/bot/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/bot/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export function GET(): Response {
  return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json; charset=utf-8" } });
}
