"use client";

import { useEffect, useRef, useState } from "react";

import { SignedOutError } from "../api";
import type { Member } from "../types";
import { backoff, botPath, requestConnection, type RelayConnection } from "./connection";

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
}

/** How often a thumbnail checks again on a browser the board says is running. */
const ASLEEP_RECHECK_MS = 30_000;

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
}: {
  member: Member;
  controlling?: boolean;
  compact?: boolean;
  onLive?: (live: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const controllingNow = useRef(controlling);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  /** Bumped to skip a reconnect's backoff, for instance when someone takes control mid-reconnect. */
  const [attempt, setAttempt] = useState(0);
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
      let connection;
      try {
        connection = await requestConnection(
          botPath(botId, "computer/browser"),
          compact ? { access: "view", wake: false } : { access: controllingNow.current ? "control" : "view" },
        );
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
        if (compact) retry(ASLEEP_RECHECK_MS);
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
      viewer.current = client;
    }

    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      viewer.current?.disconnect();
      viewer.current = null;
    };
  }, [botId, compact, watching, attempt]);

  useEffect(() => {
    controllingNow.current = controlling;
    const client = viewer.current;
    // Taking control while the picture is reconnecting: connect now rather than after the backoff.
    if (client === null && controlling && !compact) setAttempt((value) => value + 1);
    if (client === null || compact) return;
    client.viewOnly = !controlling;
    client.focusOnClick = controlling;
    if (controlling) client.focus();
  }, [controlling, compact]);

  const live = status.kind === "live";
  useEffect(() => {
    onLive?.(live);
  }, [live, onLive]);

  const poster = posterUrl(member);
  const text = compact ? null : statusText(status);
  const className = ["browser-app", compact ? "compact" : null, controlling ? "controlling" : null]
    .filter((name) => name !== null)
    .join(" ");

  return (
    <div
      className={className}
      onPaste={(event) => {
        // Lets you paste into the page with your own clipboard while in control.
        const pasted = event.clipboardData.getData("text/plain");
        if (controlling && pasted !== "") viewer.current?.clipboardPasteFrom(pasted);
      }}
    >
      {/* A live, authenticated, uncached frame: next/image would only get in the way. */}
      {!live && status.kind !== "relay" && poster !== null ? <img className="poster" src={poster} alt="" /> : null}
      <div ref={container} className="vnc" hidden={status.kind === "relay"} />
      {status.kind === "relay" ? <RelayFrame connection={status.connection} /> : null}
      {text === null ? null : (
        <div className={status.kind === "error" ? "app-status error" : "app-status"}>
          {status.kind === "error" ? null : <span className="spinner" aria-hidden="true" />}
          {text}
        </div>
      )}
    </div>
  );
}

/** Where live connections are unavailable, a frame refreshed every second or so. */
function RelayFrame({ connection }: { connection: RelayConnection }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_200);
    return () => window.clearInterval(timer);
  }, []);
  return <img className="relay" src={`${connection.frameUrl}?t=${tick}`} alt="" />;
}
