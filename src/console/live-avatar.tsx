"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { Avatar } from "./avatar";
import type { Hover, Member } from "./types";

const Mascot = dynamic(() => import("./mascot").then((module) => module.Mascot), { ssr: false });

/**
 * A list face that comes alive while you point at its row: the flat avatar,
 * with the WebGL mascot laid over it once you settle on it. Only the hovered
 * face is alive, so a long roster never runs into the browser's cap on
 * WebGL canvases. The avatar stays underneath until the mascot's first frame
 * lands, so there is no flash either way.
 */
export function LiveAvatar({
  member,
  size,
  alive,
  onHover,
}: {
  member: Member;
  size: number;
  alive: boolean;
  onHover?: (hover: Hover | null) => void;
}) {
  // A short pause before waking it, so sweeping the pointer down the list doesn't
  // start and stop a canvas per row.
  const [awake, setAwake] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!alive) {
      setAwake(false);
      setReady(false);
      return;
    }
    const timer = window.setTimeout(() => setAwake(true), 90);
    return () => window.clearTimeout(timer);
  }, [alive]);

  return (
    <span className="live-av relative inline-grid flex-none place-items-center" style={{ width: size, height: size }}>
      <Avatar member={member} size={size} className={ready ? "opacity-0" : undefined} {...(onHover === undefined ? {} : { onHover })} />
      {awake ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <Mascot member={member} size={size} interactive={false} onReady={() => setReady(true)} />
        </span>
      ) : null}
    </span>
  );
}
