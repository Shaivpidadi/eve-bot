import type { CSSProperties, ReactNode } from "react";

import type { Hover, Member, Presence } from "./types";

/**
 * Simple shapes and expressive eyes: one visual system, and a teammate you can
 * recognise at a glance. The shape and colour come from the Bot's id, so they
 * never change; the motion (see globals.css) shows what it is doing.
 */
const COLORS = [
  "#7c5cff", "#f5a524", "#2fbf71", "#ef4a4a", "#3b82f6", "#ec4899",
  "#f97316", "#14b8a6", "#a855f7", "#0ea5e9", "#9a6a47", "#e11d48",
] as const;

const HQ_COLOR = "#3b82f6";

interface Shape {
  readonly body: ReactNode;
  /** Shapes that carry their weight low get their eyes lower. */
  readonly eyes: number;
}

const SHAPES: readonly [Shape, ...Shape[]] = [
  { body: <circle cx="20" cy="20" r="17" />, eyes: 0 },
  {
    body: (
      <path d="M20 4.2 33.7 12.1v15.8L20 35.8 6.3 27.9V12.1Z" stroke="var(--av)" strokeWidth={3} strokeLinejoin="round" />
    ),
    eyes: 0,
  },
  { body: <path d="M17.3 6.4a3.1 3.1 0 0 1 5.4 0L36 30.2a3.1 3.1 0 0 1-2.7 4.6H6.7A3.1 3.1 0 0 1 4 30.2Z" />, eyes: 5 },
  { body: <path d="M11.5 32.5a7.5 7.5 0 0 1-1.3-14.9A9.8 9.8 0 0 1 29 13.1a8 8 0 0 1 .9 19.4Z" />, eyes: 3 },
  { body: <path d="M20 3.5c6.8 8.6 12.8 15 12.8 21.4a12.8 12.8 0 0 1-25.6 0C7.2 18.5 13.2 12.1 20 3.5Z" />, eyes: 5 },
  { body: <rect x="4.5" y="4.5" width="31" height="31" rx="10" />, eyes: 0 },
  { body: <rect x="3" y="9" width="34" height="23" rx="11.5" />, eyes: 1.5 },
];

function hash(text: string): number {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export function Avatar({
  member,
  size = 22,
  presence,
  onHover,
}: {
  member: Member;
  size?: number;
  /** Overrides the member's presence, for a face shown in a specific context. */
  presence?: Presence;
  onHover?: (hover: Hover | null) => void;
}) {
  const seed = hash(member.id);
  const color = member.kind === "hq" ? HQ_COLOR : (COLORS[seed % COLORS.length] ?? HQ_COLOR);
  const shape = member.kind === "hq" ? SHAPES[0] : (SHAPES[(seed >>> 7) % SHAPES.length] ?? SHAPES[0]);
  const style = { "--av": color, width: size, height: size } as CSSProperties;

  return (
    <span
      className={member.status === "paused" ? "av paused" : "av"}
      data-presence={presence ?? member.presence}
      style={style}
      onPointerEnter={
        onHover === undefined
          ? undefined
          : (event) => onHover({ member, rect: event.currentTarget.getBoundingClientRect() })
      }
      onPointerLeave={onHover === undefined ? undefined : () => onHover(null)}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <g className="body" fill="var(--av)">
          {shape.body}
        </g>
        <g transform={`translate(0 ${shape.eyes})`}>
          <g className="eyes" fill="var(--eye)">
            <rect x="13.8" y="14.2" width="3.3" height="7.6" rx="1.65" />
            <rect x="22.9" y="14.2" width="3.3" height="7.6" rx="1.65" />
          </g>
          <g className="happy" fill="none" stroke="var(--eye)" strokeWidth={2.3} strokeLinecap="round">
            <path d="M13.4 19.2q2.1-3 4.2 0" />
            <path d="M22.4 19.2q2.1-3 4.2 0" />
          </g>
        </g>
      </svg>
    </span>
  );
}
