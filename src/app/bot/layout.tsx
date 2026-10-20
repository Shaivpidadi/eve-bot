import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ServiceWorker } from "./service-worker";

/** The console as an app on a phone's Home Screen: its title, and a status bar over its own background. */
export const metadata: Metadata = {
  appleWebApp: { capable: true, title: "EVE Bot", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* With credentials, so a deployment behind Vercel Authentication still serves it to the browser. */}
      <link rel="manifest" href="/bot/manifest.webmanifest" crossOrigin="use-credentials" />
      <ServiceWorker />
      {children}
    </>
  );
}
