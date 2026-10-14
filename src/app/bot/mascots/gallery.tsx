"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

import { faceOf } from "@/console/avatar";
import type { Member, Presence } from "@/console/types";

const Mascot = dynamic(() => import("@/console/mascot").then((module) => module.Mascot), { ssr: false });

const MOODS: readonly (Presence | "paused")[] = ["idle", "thinking", "working", "waiting", "blocked", "done", "paused"];

/** One member per shape: HQ, then the first bot id that lands on each other shape. */
function oneOfEachShape(): string[] {
  const ids = ["hq"];
  for (let shape = 1; shape < 7; shape += 1) {
    for (let n = 0; n < 1000; n += 1) {
      const id = `bot_${n}`;
      if (faceOf({ id, kind: "bot" }).shape === shape) {
        ids.push(id);
        break;
      }
    }
  }
  return ids;
}

const IDS = oneOfEachShape();

/** Every face in one mood at a time: a browser allows only so many WebGL canvases at once. */
export function MascotGallery() {
  // ?turn= holds every face turned to an angle, in degrees: 180 shows the back.
  const [turn] = useState(() => {
    const asked = Number(new URLSearchParams(window.location.search).get("turn"));
    return Number.isFinite(asked) && asked !== 0 ? (asked * Math.PI) / 180 : undefined;
  });
  const [mood] = useState<Presence | "paused">(() => {
    const asked = new URLSearchParams(window.location.search).get("mood");
    return MOODS.find((entry) => entry === asked) ?? "idle";
  });
  return (
    <div style={{ padding: 28, background: "var(--bg)", minHeight: "100vh", color: "var(--text)", font: "13px var(--font)" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
        {MOODS.map((entry) => (
          <button
            key={entry}
            type="button"
            className={entry === mood ? "btn primary" : "btn"}
            data-mood={entry}
            onClick={() => {
              // A fresh page per mood: a browser allows only so many WebGL contexts.
              window.location.search = `?mood=${entry}`;
            }}
          >
            {entry}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 34, flexWrap: "wrap", alignItems: "center" }}>
        {IDS.map((id) => {
          const member = {
            id,
            kind: id === "hq" ? "hq" : "bot",
            name: id,
            status: mood === "paused" ? "paused" : "active",
            presence: mood === "paused" ? "idle" : mood,
          } as unknown as Member;
          return <Mascot key={`${id}:${mood}`} member={member} size={88} {...(turn === undefined ? {} : { turn })} />;
        })}
      </div>
    </div>
  );
}
