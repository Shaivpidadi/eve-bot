"use client";

import type { InputRequest } from "eve/client";
import { EyeIcon, FolderIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";


import { api, errorMessage, isRecord, SignedOutError } from "../api";
import { Avatar } from "../avatar";
import { PRESENCE_LABEL } from "../format";
import { roomStore, type RoomSnapshot } from "../room-store";
import type { Member } from "../types";
import { BrowserApp } from "./browser-app";
import { botPath } from "./connection";
import { FilesApp } from "./files-app";

/** Control lapses on the server if these stop, so a closed tab never leaves a Bot stuck. */
const HEARTBEAT_MS = 30_000;

const isTakeover = (request: InputRequest) =>
  request.kind === "tool-approval" && /(^|__)request_takeover$/.test(request.action?.toolName ?? "");

/**
 * The takeover request this visit answers: the one the card named, or the
 * Bot's latest unanswered request in the thread its handover points at. The
 * thread's copy of an id carries a task prefix the Bot's own copy lacks.
 */
function pendingTakeover(room: RoomSnapshot, member: Member, preferred: string | null): InputRequest | null {
  // Requests raised inside a Bot's work never report their resolution on the
  // thread's stream; the board remembers the ones a person answered.
  const answered = (request: InputRequest) =>
    room.resolutions.has(request.requestId) || member.answered[request.requestId] !== undefined;
  if (preferred !== null) {
    const named = room.asks.get(preferred);
    if (named !== undefined && !answered(named)) return named;
  }
  // Otherwise only the handover the server holds counts: old requests in the
  // thread's history are not a reason to interrupt anyone.
  const handover = member.computer.handover;
  if (handover === null) return null;
  return (
    [...room.asks.values()].find(
      (request) =>
        isTakeover(request) &&
        !answered(request) &&
        (request.requestId === handover.requestId || request.requestId.endsWith(`:${handover.requestId}`)),
    ) ?? null
  );
}

/**
 * The team's computer, the way Grok Bot shows it: its one screen, live, with
 * the browser, files, and terminal inside it, opened from any thread. Opening
 * it watches whichever Bot is at work. When a Bot needs a person for one step,
 * the screen says so; take control, do the step, and return control, and the
 * Bot carries on with the sign-in you made, as does every other Bot.
 */
export function ComputerView({
  member,
  user,
  requestId,
  onClose,
}: {
  member: Member;
  user: string;
  /** The Bot's takeover request this visit was opened for, if any. */
  requestId: string | null;
  onClose: () => void;
}) {
  const [controlling, setControlling] = useState(() => member.computer.control?.by === user);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  /** A click on the screen while only watching asks before taking the computer over. */
  const [asking, setAsking] = useState(false);
  const controllingNow = useRef(controlling);
  controllingNow.current = controlling;
  const askingNow = useRef(asking);
  askingNow.current = asking;

  const handover = member.computer.handover;
  const store = roomStore(handover?.room ?? member.room);
  const room = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const request = pendingTakeover(room, member, requestId);
  const waiting = handover !== null || request !== null;

  const control = member.computer.control;
  const heldByOther = control !== null && control.by !== user;
  const post = (path: string, body: Record<string, unknown> = {}) =>
    api(botPath(member.id, path), { method: "POST", body: JSON.stringify(body) });

  const take = async () => {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      const response = await post("computer/control", request === null ? {} : { requestId: request.requestId });
      if (response.ok) setControlling(true);
      else setError(await errorMessage(response, "Could not take control."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not take control.");
    } finally {
      setBusy(false);
    }
  };

  /** Returns control. If the Bot asked for this, approving its request is what tells it to carry on. */
  const returnControl = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await post("computer/handback", note.trim() === "" ? {} : { note: note.trim() });
      if (!response.ok) {
        setError(await errorMessage(response, "Could not return control."));
        return;
      }
      setControlling(false);
      setNote("");
      const body: unknown = await response.json().catch(() => null);
      const serverId = isRecord(body) && typeof body.requestId === "string" ? body.requestId : null;
      const target =
        request ??
        (serverId === null
          ? null
          : ([...room.asks.values()].find((ask) => ask.requestId === serverId || ask.requestId.endsWith(`:${serverId}`)) ??
            null));
      if (target !== null && !room.resolutions.has(target.requestId)) {
        await store.answer(target.requestId, "approve", "");
        onClose();
      }
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not return control.");
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    if (request === null) return;
    const option = request.options?.find((entry) => entry.id !== "approve")?.id ?? "cancel";
    setBusy(true);
    try {
      await store.answer(request.requestId, option, "");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!controlling) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await post("computer/control/heartbeat");
          if (!response.ok) {
            setControlling(false);
            setError(await errorMessage(response, "Your control ended."));
          }
        } catch {
          // The next beat tries again; the lease outlasts a missed one.
        }
      })();
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
    // `post` only closes over the Bot id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlling, member.id]);

  // Watching counts as use: the screen is not stopped for being idle while it is open here.
  useEffect(() => {
    const beat = () => void post("computer/viewing").catch(() => undefined);
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.id]);

  const close = () => {
    if (controllingNow.current) void post("computer/release").catch(() => undefined);
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // While in control, Escape belongs to the page.
      if (event.key !== "Escape" || controllingNow.current) return;
      if (askingNow.current) setAsking(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = member.status === "paused" ? "Paused" : PRESENCE_LABEL[member.presence];
  const status = controlling
    ? "You're in control"
    : heldByOther
      ? `${control.by} has control`
      : `${state}${member.action ? ` · ${member.action}` : ""}`;
  const reason = handover?.reason ?? (request === null ? null : String(request.action?.input?.reason ?? request.prompt));
  const returnLabel = member.kind === "hq" ? "Return control" : `Return control to ${member.name}`;
  // Whoever is on the computer right now: the Bot whose thread this is, when it is mid-job.
  const working = member.kind === "bot" && member.computer.active ? member.name : null;

  /** Clicking the picture while watching: the Bot that asked gets you straight in; otherwise ask first. */
  const onScreenClick = () => {
    if (controlling || busy) return;
    if (heldByOther) return;
    if (waiting) void take();
    else setAsking(true);
  };

  return (
    <div
      className={cn(
        DARK_SCOPE,
        "computer fixed inset-0 z-50 flex animate-computer-overlay-in flex-col bg-[rgba(8,8,10,0.78)] text-[#eee] backdrop-blur-[18px] backdrop-saturate-[0.8]",
      )}
      role="dialog"
      aria-modal="true"
      aria-label="Team computer"
      onClick={(event) => {
        // A click on the dimmed app around the window closes it, unless you are in control.
        if (event.target === event.currentTarget && !controllingNow.current) close();
      }}
    >
      <div className="flex h-11 flex-none items-center gap-2.5 px-3">
        <Button
          size="icon-sm"
          className="size-[26px] rounded-full bg-[#ff5f57] text-black/70 hover:bg-[#ff5f57] hover:brightness-110 [&_svg]:opacity-85 [&_svg]:hover:opacity-100"
          aria-label="Close"
          title="Close"
          onClick={close}
        >
          <XIcon strokeWidth={2.2} className="size-3.5" />
        </Button>
        <Avatar member={member} size={18} />
        <b className="text-[13px] font-medium whitespace-nowrap text-[#eee] max-[760px]:hidden">Team computer</b>
        <span className="max-w-[60%] min-w-0 flex-1 truncate text-[12.5px] text-[#9b9ba2]">{status}</span>
        {error === null ? null : <span className="max-w-[32%] truncate text-xs text-destructive">{error}</span>}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={filesOpen}
          className="text-[#b5b5bb] hover:bg-[#222225] hover:text-white aria-pressed:bg-[#222225] aria-pressed:text-white"
          title="Upload to or download from the computer"
          onClick={() => setFilesOpen((open) => !open)}
        >
          <FolderIcon data-icon="inline-start" /> Files
        </Button>
      </div>

      <div className="pointer-events-none flex min-h-0 flex-1 gap-3 px-7 pb-[78px] *:pointer-events-auto max-[760px]:flex-col max-[760px]:px-2 max-[760px]:pb-2">
        <div
          className={cn(
            "relative mx-auto aspect-[16/10] max-h-full min-w-0 flex-1 animate-computer-window-in self-center overflow-hidden rounded-[14px] border border-white/12 bg-[#161618] shadow-[0_30px_90px_rgba(0,0,0,0.6)]",
            // Stacked on a phone: as wide as the screen, as tall as that makes it, centred while the files are closed.
            "max-[760px]:my-auto max-[760px]:w-full max-[760px]:flex-none",
            controlling && "shadow-[0_0_0_2px_var(--brand),0_24px_70px_rgba(0,0,0,0.55)]",
          )}
        >
          <BrowserApp
            member={member}
            controlling={controlling}
            onControlLost={(reason) => {
              setControlling(false);
              setError(`${reason} Take control again to keep going.`);
            }}
          />

          {controlling ? null : (
            // Watching is view-only, so a click on the picture would otherwise do nothing at all.
            <div
              className="absolute inset-0 cursor-default"
              role="button"
              tabIndex={-1}
              aria-label="Take control of the computer"
              title={heldByOther ? `${control.by} has control` : "Click to take control"}
              onClick={onScreenClick}
            />
          )}

          {asking && !controlling ? (
            <HandoverCard className="top-1/2 -translate-y-1/2" role="alertdialog" aria-modal="true" aria-label="Take control?">
              <HandoverHead member={member}>{working === null ? "Take control of the computer?" : `${working} is working right now`}</HandoverHead>
              <p className="mt-2 mb-0 [overflow-wrap:anywhere] text-[#e4e4e7]">
                {working === null
                  ? "Your mouse and keyboard go straight to the computer until you return control."
                  : `Taking control pauses ${working}'s browser actions until you return control. Anything you sign in to stays signed in for the team.`}
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy} autoFocus onClick={() => void take()}>
                  Take control
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setAsking(false)}>
                  Keep watching
                </Button>
              </div>
            </HandoverCard>
          ) : null}

          {waiting && !controlling ? (
            <HandoverCard className="top-[18px]" role="alert">
              <HandoverHead member={member}>{`${member.name} needs you`}</HandoverHead>
              {reason === null ? null : <p className="mt-2 mb-0 [overflow-wrap:anywhere] text-[#e4e4e7]">{reason}</p>}
              <p className="mt-2 mb-0 text-xs text-[#8a8a92]">
                Take control, do this step on the screen, then return control. What you type goes straight to the page, never into the chat.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy || heldByOther} onClick={() => void take()}>
                  Take control
                </Button>
                {request === null ? null : (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void skip()}>
                    Skip
                  </Button>
                )}
              </div>
            </HandoverCard>
          ) : null}
        </div>

        {filesOpen ? (
          <aside
            className="flex w-[min(420px,40%)] flex-none flex-col overflow-hidden rounded-[10px] border border-[#242427] bg-[#121214] max-[760px]:h-1/2 max-[760px]:w-auto"
            aria-label="Files"
          >
            <div className="flex h-10 flex-none items-center justify-between border-b border-[#222] pr-2 pl-3 text-[12.5px]">
              <b className="font-semibold">Files on the computer</b>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-[#aaa] hover:bg-[#222] hover:text-white"
                aria-label="Close files"
                onClick={() => setFilesOpen(false)}
              >
                <XIcon />
              </Button>
            </div>
            <div className="relative min-h-0 flex-1">
              <FilesApp />
            </div>
          </aside>
        ) : null}
      </div>

      <div
        className="absolute bottom-[22px] left-1/2 z-[3] flex -translate-x-1/2 animate-computer-pill-in items-center gap-1 rounded-full bg-[rgba(250,250,252,0.96)] p-1 text-[#1a1a1d] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
        role="group"
        aria-label="Control"
      >
        {controlling ? (
          <>
            <span className="inline-flex items-center gap-[7px] pr-3 pl-2.5 text-[13px] whitespace-nowrap text-[#4a4a50]">
              <i className="size-2 animate-computer-live rounded-full bg-brand" />
              You&apos;re in control
            </span>
            <input
              className="w-[min(300px,28vw)] rounded-full border-0 bg-[#ececef] px-3 py-[7px] text-[12.5px] text-[#1a1a1d] placeholder:text-[#8a8a92] focus:outline-2 focus:outline-brand max-[760px]:w-[30vw] max-[760px]:min-w-[90px]"
              value={note}
              placeholder={waiting ? `Tell ${member.name} what you did` : "Note for the Bot (optional)"}
              aria-label={`Note for ${member.name}`}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
            <PillAction disabled={busy} onClick={() => void returnControl()}>
              {returnLabel}
            </PillAction>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-[7px] pr-3 pl-2.5 text-[13px] whitespace-nowrap text-[#4a4a50]">
              <EyeIcon className="size-3.5" />
              {heldByOther ? `${control.by} has control` : "Watching"}
            </span>
            <PillAction
              disabled={busy || heldByOther}
              title={heldByOther ? `${control.by} has control` : "Use this computer yourself"}
              onClick={() => void take()}
            >
              Take control
            </PillAction>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The computer is always dark, whatever the console's theme: its own shadcn
 * palette, set on the overlay so every component inside draws dark.
 */
const DARK_SCOPE =
  "[color-scheme:dark] [--background:#111113] [--foreground:#eeeeee] [--card:#18181b] [--card-foreground:#eeeeee] [--popover:#1b1b1e] [--popover-foreground:#eeeeee] [--primary:#f1f1f2] [--primary-foreground:#111111] [--secondary:#2a2a2e] [--secondary-foreground:#eeeeee] [--muted:#202023] [--muted-foreground:#9b9ba2] [--accent:#222225] [--accent-foreground:#ffffff] [--destructive:#f36b6b] [--border:#242427] [--input:#2e2e32] [--ring:#9b7bff]";

/** A card over the screen: a Bot that needs you, or the question before taking control. */
function HandoverCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "absolute left-1/2 w-[min(92%,440px)] -translate-x-1/2 rounded-[14px] border border-white/14 bg-[rgba(24,24,27,0.96)] px-4 py-3.5 text-[13px] shadow-[0_18px_50px_rgba(0,0,0,0.5)]",
        className,
      )}
      {...props}
    />
  );
}

function HandoverHead({ member, children }: { member: Member; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Avatar member={member} size={22} />
      <b className="text-[13.5px] font-semibold">{children}</b>
    </div>
  );
}

/** The dark action at the end of the control pill. */
function PillAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        "h-8 rounded-full bg-[#17171a] px-3.5 text-[13px] text-white hover:bg-[#17171a] hover:brightness-125 active:scale-96",
        className,
      )}
      {...props}
    />
  );
}
