import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { SITE } from "../site/content";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.origin),
  title: { default: SITE.name, template: `%s · ${SITE.name}` },
  description: SITE.tagline,
  applicationName: SITE.name,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark light",
};

/**
 * Applies the operator's theme before the first paint: their pick from the
 * console (`src/console/theme.ts`), or else the system's.
 */
const THEME_SCRIPT = `(function(){var t=null;try{t=localStorage.getItem("bot.theme")}catch(e){}if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",t)})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script sets data-theme before React hydrates, so the DOM wins.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
