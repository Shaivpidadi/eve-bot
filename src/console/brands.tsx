"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/** A tile: a dark one gets a faint inner light edge, a light one a hairline so it does not vanish on white. */
const TILE = "brand-mark grid flex-none place-items-center overflow-hidden";
const DARK_EDGE = "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.12)]";
const LIGHT_EDGE = "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1),0_1px_2px_rgba(0,0,0,0.08)]";

/**
 * Brand marks for the connector catalog, so a connector looks like the app
 * it connects. Paths for GitHub, Linear, Notion, Atlassian and Sentry are
 * from Simple Icons (CC0, simpleicons.org); DeepWiki and Context7 have none
 * there and get a drawn mark in their colours. A custom server shows its
 * site's favicon, or a lettered tile when it has none.
 */
interface Brand {
  readonly background: string;
  readonly foreground: string;
  /** A 24x24 path, or a drawing of our own. */
  readonly path?: string;
  readonly glyph?: React.ReactNode;
  /** A light tile gets a hairline so it does not vanish on white. */
  readonly light?: boolean;
}

const BRANDS: Readonly<Record<string, Brand>> = {
  github: { background: "#181717", foreground: "#ffffff", path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" },
  linear: { background: "#5E6AD2", foreground: "#ffffff", path: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" },
  notion: { background: "#ffffff", foreground: "#000000", path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z", light: true },
  atlassian: { background: "#0052CC", foreground: "#ffffff", path: "M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z" },
  sentry: { background: "#362D59", foreground: "#ffffff", path: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" },
  deepwiki: {
    background: "linear-gradient(145deg, #2f6df6, #1d3fb8)",
    foreground: "#ffffff",
    glyph: (
      <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5.5c2.6-.9 5.3-.6 8 1v12c-2.7-1.6-5.4-1.9-8-1Z" />
        <path d="M20 5.5c-2.6-.9-5.3-.6-8 1v12c2.7-1.6 5.4-1.9 8-1Z" />
      </g>
    ),
  },
  context7: {
    background: "linear-gradient(145deg, #12d18e, #059669)",
    foreground: "#ffffff",
    glyph: (
      <text x="12" y="16.2" textAnchor="middle" fontSize="10.5" fontWeight="700" fill="currentColor" fontFamily="ui-monospace, Menlo, monospace">
        C7
      </text>
    ),
  },
};

export const hasBrand = (id: string | null | undefined): boolean => id != null && id in BRANDS;

/** An app-icon tile for a connector: its brand, its site's icon, or its initial. */
export function BrandMark({
  brand,
  label,
  url,
  size = 44,
  className,
}: {
  brand?: string | null;
  label: string;
  /** A custom server's address, whose site icon is tried before the initial. */
  url?: string | null;
  size?: number;
  /** Extra classes for where it sits (an overlap, a ring). */
  className?: string;
}) {
  const known = brand ? BRANDS[brand] : undefined;
  const [favicon, setFavicon] = useState<"try" | "failed">("try");
  const radius = Math.round(size * 0.27);
  if (known !== undefined) {
    return (
      <span
        className={cn(TILE, known.light ? LIGHT_EDGE : DARK_EDGE, className)}
        style={{ width: size, height: size, borderRadius: radius, background: known.background, color: known.foreground }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.56)} height={Math.round(size * 0.56)}>
          {known.path ? <path d={known.path} fill="currentColor" /> : known.glyph}
        </svg>
      </span>
    );
  }
  let site: string | null = null;
  try {
    site = url ? new URL(url).origin : null;
  } catch {
    site = null;
  }
  if (site !== null && favicon === "try") {
    return (
      <span className={cn(TILE, LIGHT_EDGE, "bg-white", className)} style={{ width: size, height: size, borderRadius: radius }} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="object-contain" src={`${site}/favicon.ico`} alt="" width={Math.round(size * 0.55)} height={Math.round(size * 0.55)} onError={() => setFavicon("failed")} />
      </span>
    );
  }
  return (
    <span className={cn(TILE, DARK_EDGE, "bg-primary font-semibold text-primary-foreground", className)} style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
