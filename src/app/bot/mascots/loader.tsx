"use client";

import dynamic from "next/dynamic";

/** The gallery reads the address bar, so it renders in the browser only. */
const MascotGallery = dynamic(() => import("./gallery").then((module) => module.MascotGallery), { ssr: false });

export function MascotGalleryLoader() {
  return <MascotGallery />;
}
