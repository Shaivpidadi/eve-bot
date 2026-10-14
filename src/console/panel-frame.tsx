"use client";

import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";

/** How long the details panel takes to slide open or closed; matches the panel slot's transition in console.tsx. */
export const PANEL_SLIDE_MS = 240;

const KEY = "bot.panel-width";
export const PANEL_DEFAULT_WIDTH = 300;
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 900;
/** The sidebar's column, and the room the chat keeps beside a wide panel. */
const SIDEBAR_WIDTH = 264;
const CHAT_MIN_WIDTH = 380;
const KEY_STEP = 24;

function read(): number | null {
  try {
    const value = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(width: number): void {
  try {
    window.localStorage.setItem(KEY, String(width));
  } catch {
    // Private browsing: the width lasts for this page only.
  }
}

const maxWidth = () =>
  Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, window.innerWidth - SIDEBAR_WIDTH - CHAT_MIN_WIDTH));
const clamp = (width: number) => Math.round(Math.min(maxWidth(), Math.max(PANEL_MIN_WIDTH, width)));

/**
 * The details panel's width: what the operator dragged it to, remembered in this
 * browser, and narrowed while the window is too small to fit it beside the chat.
 */
export function usePanelWidth(): readonly [number, (width: number) => void] {
  const [preferred, setPreferred] = useState(() => read() ?? PANEL_DEFAULT_WIDTH);
  const [, setViewport] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => write(preferred), 250);
    return () => window.clearTimeout(timer);
  }, [preferred]);

  const update = useCallback((width: number) => setPreferred(clamp(width)), []);
  return [clamp(preferred), update] as const;
}

/**
 * The panel's left edge, dragged to make the team's computer and the panel wider
 * or narrower. Arrow keys work too, and a double-click puts it back.
 */
export function PanelResizer({
  width,
  onWidth,
  onResizing,
}: {
  width: number;
  onWidth: (width: number) => void;
  onResizing: (resizing: boolean) => void;
}) {
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    onResizing(true);
    const move = (moved: globalThis.PointerEvent) => onWidth(window.innerWidth - moved.clientX);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      onResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") onWidth(width + KEY_STEP);
    else if (event.key === "ArrowRight") onWidth(width - KEY_STEP);
    else return;
    event.preventDefault();
  };

  return (
    <div
      // A 7px grab strip on the panel's edge with a 2px line that lights up while hovered,
      // focused or dragged (the app carries data-resizing during a drag). Hidden where the
      // panel is an overlay rather than a column.
      className="absolute inset-y-0 left-0 z-5 w-[7px] cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-transparent after:transition-colors after:content-[''] hover:after:bg-brand focus-visible:after:bg-brand in-data-resizing:after:bg-brand max-[1080px]:hidden"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={maxWidth()}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={drag}
      onKeyDown={nudge}
      onDoubleClick={() => onWidth(PANEL_DEFAULT_WIDTH)}
    />
  );
}
