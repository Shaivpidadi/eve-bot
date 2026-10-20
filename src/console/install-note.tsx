"use client";

import { MonitorDownIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * "Install the app" in the sidebar's footer (docs/plan/notifications.md, N1).
 *
 * Chromium browsers offer an install prompt the console can raise; Safari has
 * none, so there it says how (on iPhone and iPad, installing is also what
 * lets the console send notifications). Never shown inside the installed app,
 * and gone once dismissed.
 */

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Way = { kind: "prompt"; event: InstallPrompt } | { kind: "ios" } | { kind: "mac-safari" } | null;

const DISMISSED = "bot.install-dismissed";

const installed = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
}

/** Safari, which installs only by hand: from the Share sheet on iPhone and iPad, from the File menu on a Mac. */
function safariWay(): Way {
  const agent = navigator.userAgent;
  const safari = /Safari\//.test(agent) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\//.test(agent);
  const ios = /iPhone|iPad|iPod/.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && safari) return { kind: "ios" };
  if (safari && /Macintosh/.test(agent)) return { kind: "mac-safari" };
  return null;
}

export function InstallNote() {
  const [way, setWay] = useState<Way>(null);

  useEffect(() => {
    if (installed() || dismissed()) return;
    setWay(safariWay());
    const offer = (event: Event) => {
      event.preventDefault();
      setWay({ kind: "prompt", event: event as InstallPrompt });
    };
    const done = () => setWay(null);
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", offer);
      window.removeEventListener("appinstalled", done);
    };
  }, []);

  if (way === null) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED, "1");
    } catch {
      // Shown again next time; nothing worse.
    }
    setWay(null);
  };
  const row = "flex min-w-0 flex-1 items-center gap-[9px] rounded-lg px-2 py-[7px] text-[12.5px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground";
  const label = (
    <>
      <MonitorDownIcon className="size-[15px] flex-none" />
      <span className="truncate">Install the app</span>
    </>
  );

  return (
    <div className="flex w-full items-center">
      {way.kind === "prompt" ? (
        <button
          type="button"
          className={`${row} cursor-pointer`}
          title="Its own window and icon, and notifications when a Bot needs you"
          onClick={async () => {
            await way.event.prompt();
            await way.event.userChoice;
            // A prompt can be raised once; installed or not, the browser's own menu is the way from here.
            setWay(null);
          }}
        >
          {label}
        </button>
      ) : (
        <Popover>
          <PopoverTrigger className={`${row} cursor-pointer`}>{label}</PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-64 text-[12.5px] leading-snug">
            {way.kind === "ios" ? (
              <p className="m-0">
                Tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>. The app opens in its own window, and on iPhone it is also how a Bot can send you
                notifications.
              </p>
            ) : (
              <p className="m-0">
                In Safari&apos;s menu bar, choose <b>File → Add to Dock</b>. The app opens in its own window.
              </p>
            )}
          </PopoverContent>
        </Popover>
      )}
      <button type="button" className="flex-none cursor-pointer rounded-md p-1.5 text-faint hover:text-foreground" aria-label="Don't show again" title="Don't show again" onClick={dismiss}>
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
