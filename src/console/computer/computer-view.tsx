"use client";

import type { InputRequest } from "eve/client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api, errorMessage, isRecord, SignedOutError } from "../api";
import { Avatar } from "../avatar";
import { PRESENCE_LABEL } from "../format";
import { Icon } from "../icons";
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
    <div className="computer" role="dialog" aria-modal="true" aria-label="Team computer">
      <div className="computer-bar">
        <button type="button" className="computer-close" aria-label="Close" title="Close" onClick={close}>
          <Icon name="x" size={14} />
        </button>
        <Avatar member={member} size={18} />
        <b>Team computer</b>
        <span className="what">{status}</span>
        {error === null ? null : <span className="error-text">{error}</span>}
        <button
          type="button"
          className={filesOpen ? "btn subtle on" : "btn subtle"}
          title="Upload to or download from the computer"
          onClick={() => setFilesOpen((open) => !open)}
        >
          <Icon name="folder" size={14} /> Files
        </button>
        {controlling ? (
          <>
            <input
              className="control-note"
              value={note}
              placeholder={waiting ? `Tell ${member.name} what you did (optional)` : "Note for the Bot (optional)"}
              aria-label={`Note for ${member.name}`}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
            <button type="button" className="btn primary" disabled={busy} onClick={() => void returnControl()}>
              {returnLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={busy || heldByOther}
            title={heldByOther ? `${control.by} has control` : "Use this computer yourself"}
            onClick={() => void take()}
          >
            Take control
          </button>
        )}
      </div>

      <div className="computer-stage">
        <div className={controlling ? "screen-frame controlling" : "screen-frame"}>
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
              className="take-catcher"
              role="button"
              tabIndex={-1}
              aria-label="Take control of the computer"
              title={heldByOther ? `${control.by} has control` : "Click to take control"}
              onClick={onScreenClick}
            />
          )}

          {asking && !controlling ? (
            <div className="handover take-prompt" role="alertdialog" aria-modal="true" aria-label="Take control?">
              <div className="handover-head">
                <Avatar member={member} size={22} />
                <b>{working === null ? "Take control of the computer?" : `${working} is working right now`}</b>
              </div>
              <p>
                {working === null
                  ? "Your mouse and keyboard go straight to the computer until you return control."
                  : `Taking control pauses ${working}'s browser actions until you return control. Anything you sign in to stays signed in for the team.`}
              </p>
              <div className="handover-actions">
                <button type="button" className="btn primary" disabled={busy} autoFocus onClick={() => void take()}>
                  Take control
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setAsking(false)}>
                  Keep watching
                </button>
              </div>
            </div>
          ) : null}

          {waiting && !controlling ? (
            <div className="handover" role="alert">
              <div className="handover-head">
                <Avatar member={member} size={22} />
                <b>{`${member.name} needs you`}</b>
              </div>
              {reason === null ? null : <p>{reason}</p>}
              <p className="faint">Take control, do this step on the screen, then return control. What you type goes straight to the page, never into the chat.</p>
              <div className="handover-actions">
                <button type="button" className="btn primary" disabled={busy || heldByOther} onClick={() => void take()}>
                  Take control
                </button>
                {request === null ? null : (
                  <button type="button" className="btn" disabled={busy} onClick={() => void skip()}>
                    Skip
                  </button>
                )}
              </div>
            </div>
          ) : null}

        </div>

        {filesOpen ? (
          <aside className="files-drawer" aria-label="Files">
            <div className="files-drawer-head">
              <b>Files on the computer</b>
              <button type="button" className="icon-btn" aria-label="Close files" onClick={() => setFilesOpen(false)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="files-drawer-body">
              <FilesApp />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
