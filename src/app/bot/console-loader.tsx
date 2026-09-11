"use client";

import dynamic from "next/dynamic";

/**
 * The console lives entirely in the browser: it reads local preferences, holds
 * live streams open, and renders times in the viewer's timezone. Skipping the
 * server render avoids a hydration pass that would only ever mismatch.
 */
const Console = dynamic(() => import("@/console/console").then((module) => module.Console), {
  ssr: false,
  loading: () => <div className="app-loading" aria-busy="true" />,
});

export function ConsoleLoader() {
  return <Console />;
}
