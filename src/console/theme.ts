"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Also read by the inline script in `src/app/layout.tsx`, which applies the theme before the first paint. */
const KEY = "bot.theme";
const LIGHT = "(prefers-color-scheme: light)";

function stored(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

const system = (): Theme => (window.matchMedia(LIGHT).matches ? "light" : "dark");

/**
 * Light or dark. It follows the system until the operator picks one, and then
 * remembers the pick in this browser. The layout's inline script sets it before
 * the first paint; this keeps it set, since React's development remount clears
 * attributes it does not manage on `<html>`.
 */
export function useTheme(): readonly [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia(LIGHT);
    const follow = () => {
      if (stored() === null) setTheme(system());
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Private browsing: the pick lasts for this page only.
    }
    setTheme(next);
  }, [theme]);

  return [theme, toggle] as const;
}
