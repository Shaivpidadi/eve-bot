"use client";

import { useEffect, useId, useState } from "react";

import { api, errorMessage, SignedOutError } from "./api";
import { Avatar } from "./avatar";
import { BrowserApp, posterUrl } from "./computer/browser-app";
import { bytes, PRESENCE_LABEL, scheduleText, shortWhen } from "./format";
import { Icon } from "./icons";
import type { Hover, Member } from "./types";

export type PanelView = "overview" | "settings";

/** Lighter in the morning, darker at night: the Bot's computer keeps its own time. */
function palette(hour: number): readonly [string, string, string] {
  if (hour >= 6 && hour < 11) return ["#f3f3f3", "#d4d4d4", "#8f8f8f"];
  if (hour >= 11 && hour < 16) return ["#c4c4c4", "#ececec", "#ffffff"];
  if (hour >= 16 && hour < 19) return ["#9b9b9b", "#e2e2e2", "#ffffff"];
  if (hour >= 19 && hour < 22) return ["#2d2d2d", "#575757", "#d0d0d0"];
  return ["#121212", "#2a2a2a", "#9a9a9a"];
}

export function Wallpaper() {
  const id = useId().replaceAll(":", "");
  const [from, to, band] = palette(new Date().getHours());
  const curve = "M-12 -8 C 42 6, 58 52, 92 78 S 150 108, 176 104";
  return (
    <svg className="wall" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
        <filter id={`b${id}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <rect width="160" height="100" fill={`url(#g${id})`} />
      <path d={curve} fill="none" stroke={band} strokeWidth={16} opacity={0.5} filter={`url(#b${id})`} />
      <path d={curve} fill="none" stroke={band} strokeWidth={1.4} opacity={0.85} />
    </svg>
  );
}

/** The latest still frame of a Bot's screen, swapped in only once it has loaded. */
export function useScreen(member: Member): string | null {
  const url = member.kind === "bot" ? posterUrl(member) : null;
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (url === null) return;
    let cancelled = false;
    const probe = new Image();
    probe.onload = () => {
      if (!cancelled) setLoaded(url);
    };
    probe.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (url === null || loaded === null) return null;
  // Keep this Bot's previous frame up while the next one loads, never another Bot's.
  return loaded.split("?t=")[0] === url.split("?t=")[0] ? loaded : null;
}

export function DetailsPanel({
  member,
  members,
  view,
  onView,
  onClose,
  onSelect,
  onTakeover,
  onChanged,
  onHover,
  live,
}: {
  member: Member;
  members: readonly Member[];
  /** Whether the thumbnail may stream; off while the full computer is open. */
  live: boolean;
  view: PanelView;
  onView: (view: PanelView) => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onTakeover: () => void;
  onChanged: () => Promise<void>;
  onHover: (hover: Hover | null) => void;
}) {
  const settings = member.kind === "bot" && view === "settings";
  return (
    <aside className="panel" aria-label="Details">
      <div className="panel-head">
        {settings ? (
          <button type="button" className="icon-btn" aria-label="Back" onClick={() => onView("overview")}>
            <Icon name="left" />
          </button>
        ) : null}
        <span className="spacer" />
        {member.kind === "bot" && !settings ? (
          <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={() => onView("settings")}>
            <Icon name="gear" />
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="panel-body">
        {member.kind === "hq" ? (
          <HqPanel members={members} onSelect={onSelect} onHover={onHover} />
        ) : settings ? (
          <SettingsPanel key={member.id} member={member} onChanged={onChanged} />
        ) : (
          <BotPanel member={member} live={live} onTakeover={onTakeover} />
        )}
      </div>
    </aside>
  );
}

function BotPanel({ member, live, onTakeover }: { member: Member; live: boolean; onTakeover: () => void }) {
  const screen = useScreen(member);
  const [streaming, setStreaming] = useState(false);
  const paused = member.status === "paused";
  const showing = live && streaming;

  useEffect(() => {
    if (!live) setStreaming(false);
  }, [live]);

  return (
    <>
      <button type="button" className="screen" aria-label={`Open ${member.name}'s computer`} onClick={onTakeover}>
        <Wallpaper />
        {live ? (
          <BrowserApp member={member} compact onLive={setStreaming} />
        ) : screen === null ? null : (
          // A live, authenticated, uncached frame: next/image would only get in the way.
          <img src={screen} alt="" />
        )}
        {member.computer.control !== null ? (
          <span className="screen-live">{`${member.computer.control.by} has control`}</span>
        ) : member.computer.active ? (
          <span className="screen-live">Working</span>
        ) : showing ? (
          <span className="screen-live">Live</span>
        ) : null}
        {/* The live picture has the computer's own dock. */}
        {showing ? null : (
          <span className="dock">
            <Avatar member={member} size={10} />
            <i />
            <i />
            <i />
          </span>
        )}
      </button>
      <div className="screen-caption">
        {showing || member.computer.browser === "on" || member.computer.posterAt === null
          ? `${member.name}'s computer`
          : `${member.name}'s computer · asleep, last seen ${shortWhen(member.computer.posterAt)}`}
      </div>

      <div className="section">
        <h3>Routines</h3>
        <ul className="list">
          {member.routines.length === 0 ? (
            <li className="muted-row">No routines yet</li>
          ) : (
            member.routines.map((routine) => (
              <li key={routine.jobId}>
                <Icon name={paused ? "clock" : "check"} size={15} className={paused ? undefined : "ok"} />
                <div>
                  <b>{routine.title}</b>
                  <span>{scheduleText(routine, paused)}</span>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      {member.files.length === 0 ? null : (
        <div className="section">
          <h3>Files</h3>
          <ul className="list">
            {member.files.map((file) => (
              <li key={file.id}>
                <Icon name="file" size={15} />
                <a href={`/bot/v1/artifacts/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer">
                  <b>{file.name}</b>
                  <span>
                    {bytes(file.bytes)} · {shortWhen(file.at)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function SettingsPanel({ member, onChanged }: { member: Member; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = member.profile;
  const paused = member.status === "paused";

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/bot/v1/bots/${encodeURIComponent(member.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: paused ? "active" : "paused" }),
      });
      if (response.ok) await onChanged();
      else setError(await errorMessage(response, "Could not change the Bot."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not change the Bot.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="profile">
        <Avatar member={member} size={52} />
        <h2>{member.name}</h2>
        <p>{member.title}</p>
        <p className="faint">
          {paused ? "Paused" : PRESENCE_LABEL[member.presence]}
          {member.action ? ` · ${member.action}` : ""}
        </p>
      </div>

      {profile === null ? null : (
        <>
          <div className="section">
            <h3>{`How ${member.name} works`}</h3>
            <p className="prose">{profile.persona}</p>
          </div>
          <div className="section">
            <h3>Playbook</h3>
            <ul className="list">
              {profile.playbook.length === 0 ? (
                <li className="muted-row">Nothing learned yet</li>
              ) : (
                profile.playbook.map((lesson) => (
                  <li key={lesson}>
                    <Icon name="brain" size={15} />
                    <div>{lesson}</div>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div className="section">
            <h3>Record</h3>
            <p className="prose">
              {`${profile.stats.jobsCompleted} done · ${profile.stats.jobsFailed} failed · joined ${shortWhen(profile.hiredAt)}`}
              {profile.createdBy === null ? "" : ` · created by ${profile.createdBy}`}
            </p>
          </div>
        </>
      )}

      <div className="section">
        <button type="button" className="btn" disabled={busy} onClick={() => void toggle()}>
          {paused ? `Resume ${member.name}` : `Pause ${member.name}`}
        </button>
        {error === null ? null : <p className="error-text">{error}</p>}
      </div>
      <p className="faint">{`To retire ${member.name}, ask HQ. It will ask for your approval first.`}</p>
    </>
  );
}

function HqPanel({
  members,
  onSelect,
  onHover,
}: {
  members: readonly Member[];
  onSelect: (id: string) => void;
  onHover: (hover: Hover | null) => void;
}) {
  const bots = members.filter((member) => member.kind === "bot");
  const waiting = bots.filter((bot) => bot.presence === "waiting" || bot.pending > 0);

  return (
    <>
      <div className="section">
        <h3>Team</h3>
        <ul className="list">
          {bots.length === 0 ? (
            <li className="muted-row">No Bots yet. Ask HQ to hire one, or press +.</li>
          ) : (
            bots.map((bot) => (
              <li key={bot.id}>
                <button type="button" className="team-row" onClick={() => onSelect(bot.id)}>
                  <Avatar member={bot} size={20} onHover={onHover} />
                  <div>
                    <b>{bot.name}</b>
                    <span>
                      {bot.status === "paused" ? "Paused" : PRESENCE_LABEL[bot.presence]} · {bot.action ?? bot.title}
                    </span>
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {waiting.length === 0 ? null : (
        <div className="section">
          <h3>Waiting on you</h3>
          <ul className="list">
            {waiting.map((bot) => (
              <li key={bot.id}>
                <button type="button" className="team-row" onClick={() => onSelect(bot.id)}>
                  <Icon name="alert" size={15} />
                  <div>
                    <b>{bot.name}</b>
                    <span>{bot.action ?? "Needs a decision"}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
