"use client";

import { useEffect } from "react";

/** Registers the console's service worker (`public/bot/sw.js`), which makes it installable as an app. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // `/bot` rather than `/bot/` takes in the console's own page; next.config.ts allows it with Service-Worker-Allowed.
    navigator.serviceWorker.register("/bot/sw.js", { scope: "/bot", updateViaCache: "none" }).catch(() => {
      // Not installable here (an insecure origin, a blocked worker); the console works the same without it.
    });
  }, []);
  return null;
}
