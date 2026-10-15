import { notFound } from "next/navigation";

import { MascotGalleryLoader } from "./loader";

/** Every face in every mood, for designing the mascot. Development only. */
export default function MascotsPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MascotGalleryLoader />;
}
