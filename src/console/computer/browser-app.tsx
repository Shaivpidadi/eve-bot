"use client";

import { useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { SignedOutError } from "../api";
import type { Member } from "../types";
import { backoff, botPath, requestConnection, type RelayConnection } from "./connection";
import { forwardMacShortcuts, PASTE, sendChord } from "./shortcuts";

type Status =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  | { readonly kind: "asleep" }
  | { readonly kind: "starting"; readonly detail: string }
  | { readonly kind: "relay"; readonly connection: RelayConnection }
  | { readonly kind: "error"; readonly message: string };

interface Viewer {
  viewOnly: boolean;
  focusOnClick: boolean;
  disconnect(): void;
  focus(): void;
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

/** How often a thumbnail checks again on a browser the board says is running. */
const ASLEEP_RECHECK_MS = 30_000;
/** How often the full view tries again after the computer answered that it cannot connect. */
const ERROR_RETRY_MS = 8_000;

/** The last still frame, shown until the live picture arrives. */
export const posterUrl = (member: Member): string | null =>
  member.computer.posterAt === null
    ? null
    : `${botPath(member.id, "screen")}?t=${encodeURIComponent(member.computer.posterAt)}`;

function statusText(status: Status): string | null {
  switch (status.kind) {
    case "connecting":
      return "Connecting to the browser…";
    case "starting":
      return status.detail;
    case "error":
      return status.message;
    default:
      return null;
  }
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * A Bot's browser, live, over the computer's gateway. Watching is view only;
 * while you hold control your mouse and keyboard go straight to the page, so
 * passwords typed here never pass through the Bot or the chat.
 *
 * `compact` is the thumbnail in a Bot's panel. It watches a browser that is
 * already running and never starts one, streams at low picture quality, and
 * lets go while the tab is hidden, so an open console costs nothing when no
 * Bot is working.
 */
export function BrowserApp({
  member,
  controlling = false,
  compact = false,
  onLive,
  onControlLost,
}: {
  member: Member;
  controlling?: boolean;
  compact?: boolean;
  onLive?: (live: boolean) => void;
  /** The computer refused a control connection: the lease lapsed while the picture was down. */
  onControlLost?: (reason: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const controllingNow = useRef(controlling);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  /** Bumped to skip a reconnect's backoff, for instance when someone takes control mid-reconnect. */
  const [attempt, setAttempt] = useState(0);
  /** A still frame that failed to load is left out rather than shown as a broken image. */
  const [brokenPoster, setBrokenPoster] = useState<string | null>(null);
  const visible = usePageVisible();
  const botId = member.id;
  const watching = !compact || (visible && member.computer.browser === "on");

  useEffect(() => {
    if (!watching) {
      setStatus({ kind: "asleep" });
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    let failures = 0;

    const retry = (delay: number) => {
      timer = window.setTimeout(() => void connect(), delay);
    };

    async function connect(): Promise<void> {
      if (disposed) return;
      const wantsControl = !compact && controllingNow.current;
      let connection;
      try {
        connection = await requestConnection(
          botPath(botId, "computer/browser"),
          compact ? { access: "view", wake: false } : { access: wantsControl ? "control" : "view" },
        );
        if (wantsControl && connection.mode === "unavailable" && /control/i.test(connection.error)) {
          // Control lapsed while the picture was down (a missed heartbeat, a sleeping
          // laptop). Watch instead, and let the view offer to take control again.
          controllingNow.current = false;
          onControlLost?.(connection.error);
          connection = await requestConnection(botPath(botId, "computer/browser"), { access: "view" });
        }
      } catch (error) {
        if (error instanceof SignedOutError || disposed) return;
        failures += 1;
        setStatus({ kind: "connecting" });
        retry(backoff(failures));
        return;
      }
      if (disposed) return;

      if (connection.mode === "starting") {
        setStatus({ kind: "starting", detail: connection.detail });
        retry(connection.retryAfterMs);
        return;
      }
      // A thumbnail does not poll relayed frames: it waits for a live connection.
      if (connection.mode === "asleep" || (compact && connection.mode === "relay")) {
        setStatus({ kind: "asleep" });
        retry(ASLEEP_RECHECK_MS);
        return;
      }
      if (connection.mode === "relay") {
        setStatus({ kind: "relay", connection });
        return;
      }
      if (connection.mode !== "vnc") {
        setStatus({ kind: "error", message: connection.mode === "unavailable" ? connection.error : "Unexpected answer." });
        // The computer may be restarting or restoring; keep asking so the picture comes back on its own.
        retry(compact ? ASLEEP_RECHECK_MS : ERROR_RETRY_MS);
        return;
      }

      const { default: RFB } = await import("@novnc/novnc");
      const target = container.current;
      if (disposed || target === null) return;
      target.replaceChildren();
      const client = new RFB(target, connection.url);
      client.scaleViewport = true;
      client.resizeSession = false;
      client.background = "transparent";
      client.viewOnly = compact || !controllingNow.current;
      client.focusOnClick = !compact && controllingNow.current;
      // The pointer follows the remote cursor while in control; if the computer
      // ever reports an invisible cursor, a dot stands in so it never disappears.
      client.showDotCursor = true;
      if (compact) {
        // A few hundred pixels wide: trade picture quality for far less traffic.
        client.qualityLevel = 2;
        client.compressionLevel = 9;
      }
      client.addEventListener("connect", () => {
        failures = 0;
        if (!disposed) setStatus({ kind: "live" });
      });
      client.addEventListener("disconnect", () => {
        if (viewer.current === client) viewer.current = null;
        if (disposed) return;
        failures += 1;
        setStatus({ kind: "connecting" });
        // Tokens are single use, so every reconnect asks for a new one.
        retry(backoff(failures));
      });
      client.addEventListener("clipboard", (event) => {
        // What you copy on the computer lands on your own clipboard while you are in control.
        const copied = (event as CustomEvent<{ text?: unknown }>).detail?.text;
        if (controllingNow.current && typeof copied === "string") {
          void navigator.clipboard?.writeText(copied).catch(() => undefined);
        }
      });
      stopShortcuts();
      stopShortcuts = forwardMacShortcuts(target, client, () => controllingNow.current);
      viewer.current = client;
    }

    let stopShortcuts = () => {};
    void connect();
    return () => {
      disposed = true;
      stopShortcuts();
      window.clearTimeout(timer);
      viewer.current?.disconnect();
      viewer.current = null;
    };
  }, [botId, compact, watching, attempt]);

  const mounted = useRef(false);
  useEffect(() => {
    controllingNow.current = controlling;
    const client = viewer.current;
    if (!mounted.current) {
      // The first connection is on its way with this access already.
      mounted.current = true;
      return;
    }
    // Control changed while the picture is down: connect now, with the right access, rather than
    // after the backoff — or never, if the last attempt ended in an error.
    if (client === null && !compact) setAttempt((value) => value + 1);
    if (client === null || compact) return;
    client.viewOnly = !controlling;
    client.focusOnClick = controlling;
    if (controlling) client.focus();
  }, [controlling, compact]);

  const live = status.kind === "live";
  useEffect(() => {
    onLive?.(live);
  }, [live, onLive]);

  const posterCandidate = posterUrl(member);
  const poster = posterCandidate !== null && posterCandidate === brokenPoster ? null : posterCandidate;
  const text = compact ? null : statusText(status);
  // Nothing to show yet: a placeholder browser stands in until the picture arrives.
  const loading = !live && (status.kind === "connecting" || status.kind === "starting") && poster === null;
  return (
    <div
      className={cn(
        "browser-app absolute inset-0 bg-[#161618]",
        // The thumbnail in a Bot's panel: the wallpaper shows through until a picture arrives, and clicks open the computer.
        compact && "compact pointer-events-none bg-transparent",
      )}
      onPaste={(event) => {
        // Pastes your own clipboard into the page while in control: hand it to the computer, then
        // press Ctrl+V there, since the computer's browser runs on Linux.
        const pasted = event.clipboardData.getData("text/plain");
        const client = viewer.current;
        if (!controlling || client === null || pasted === "") return;
        event.preventDefault();
        client.clipboardPasteFrom(pasted);
        sendChord(client, PASTE);
      }}
    >
      {/* A live, authenticated, uncached frame: next/image would only get in the way. */}
      {!live && status.kind !== "relay" && poster !== null ? (
        <img
          className={cn(
            "absolute inset-0 size-full object-contain",
            compact ? "object-cover object-top-left" : "brightness-[0.55]",
          )}
          src={poster}
          alt=""
          onError={() => setBrokenPoster(poster)}
        />
      ) : null}
      {loading ? <ScreenSkeleton compact={compact} /> : null}
      <div
        ref={container}
        className={cn(
          "absolute inset-0",
          // Watching: keep the viewer's own arrow. noVNC hides it (cursor: none) until the computer sends a
          // cursor shape, which a view-only connection may never receive; only in control does the pointer
          // follow the computer's cursor.
          !controlling && "[&_canvas]:cursor-default!",
        )}
        hidden={status.kind === "relay"}
      />
      {status.kind === "relay" ? <RelayFrame connection={status.connection} /> : null}
      {text === null ? null : (
        <div
          className={cn(
            "absolute top-1/2 left-1/2 flex max-w-[min(90%,460px)] -translate-1/2 items-center gap-[9px] rounded-[10px] border border-[#2a2a2e] bg-[rgba(20,20,22,0.9)] px-3.5 py-[9px] text-[12.5px] text-[#d6d6db]",
            status.kind === "error" && "text-[#f36b6b]",
          )}
        >
          {status.kind === "error" ? null : <Spinner className="size-3.5 text-[#eee]" aria-hidden="true" />}
          {text}
        </div>
      )}
    </div>
  );
}

/** The shape of a browser window, shimmering, while the real one is on its way. Sized in container units, so it fits any screen. */
function ScreenSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      className={cn(
        "@container absolute inset-0 flex flex-col overflow-hidden",
        compact ? "bg-[rgba(28,28,31,0.92)]" : "bg-[#1c1c1f]",
        "after:absolute after:inset-0 after:animate-computer-sweep after:bg-[linear-gradient(100deg,transparent_30%,rgba(255,255,255,0.07)_50%,transparent_70%)] after:bg-size-[200%_100%] after:content-['']",
      )}
      aria-hidden="true"
    >
      <div className="flex items-center gap-[2.2cqw] bg-[#26262a] px-[3cqw] py-[2.2cqw]">
        <i className="block size-[2.6cqw] rounded-full bg-[#3a3a40]" />
        <i className="block size-[2.6cqw] rounded-full bg-[#3a3a40]" />
        <i className="block size-[2.6cqw] rounded-full bg-[#3a3a40]" />
        <span className="ml-[2cqw] h-[5cqw] flex-1 rounded-[2.5cqw] bg-[#32323a]" />
      </div>
      <div className="flex flex-1 flex-col gap-[3.4cqw] px-[8cqw] py-[5cqw]">
        <SkeletonLine width="w-2/5" />
        <SkeletonLine width="w-9/10" />
        <SkeletonLine width="w-3/4" />
        <span className="block h-[22cqw] rounded-[2cqw] bg-[#26262b]" />
        <SkeletonLine width="w-3/5" />
        <SkeletonLine width="w-[85%]" />
      </div>
    </div>
  );
}

function SkeletonLine({ width }: { width: string }) {
  return <span className={cn("block h-[3cqw] rounded-[1.5cqw] bg-[#2b2b30]", width)} />;
}

/** Where live connections are unavailable, a frame refreshed every second or so. */
function RelayFrame({ connection }: { connection: RelayConnection }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_200);
    return () => window.clearInterval(timer);
  }, []);
  return <img className="absolute inset-0 size-full object-contain" src={`${connection.frameUrl}?t=${tick}`} alt="" />;
}
