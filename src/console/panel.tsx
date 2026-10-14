"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { api, errorMessage, SignedOutError } from "./api";
import { Avatar } from "./avatar";
import { Mascot } from "./mascot";
import { posterUrl } from "./computer/browser-app";
import { bytes, clock, PRESENCE_LABEL, scheduleText, shortWhen, withoutEmoji } from "./format";
import { Icon, type IconName } from "./icons";
import { RoutineDialog } from "./routine-dialog";
import type { ActivityEvent, Hover, Member, Routine } from "./types";
import { modelsOf, tokens, usd } from "../../agent/lib/usage-format";

/**
 * What a member's model steps have cost, all time: which models, how many
 * tokens in and out, and the bill as the provider priced it. Nothing shows
 * until the first step has been counted.
 */
function UsageSection({ member }: { member: Member }) {
  const usage = member.usage;
  if (usage === undefined || usage.steps === 0) return null;
  const models = Object.entries(usage.models).sort((left, right) => right[1] - left[1]);
  return (
    <div className="section">
      <h3>Usage</h3>
      <ul className="list usage">
        <li>
          <Icon name="dot" size={15} />
          <div>
            <b>{models.length === 0 ? "Model not reported" : models.length === 1 ? models[0]![0] : `${models.length} models`}</b>
            <span>{models.length > 1 ? models.map(([model, steps]) => `${model} ×${steps}`).join(" · ") : `${usage.steps} model ${usage.steps === 1 ? "step" : "steps"}`}</span>
          </div>
        </li>
        <li>
          <Icon name="dot" size={15} />
          <div>
            <b>
              {tokens(usage.inputTokens)} in · {tokens(usage.outputTokens)} out
            </b>
            <span>
              {usage.cacheReadTokens > 0 ? `${tokens(usage.cacheReadTokens)} read from cache` : "no cache reads"}
              {(usage.cacheWriteTokens ?? 0) > 0 ? ` · ${tokens(usage.cacheWriteTokens ?? 0)} written` : ""}
            </span>
          </div>
        </li>
        <li>
          <Icon name="dot" size={15} />
          <div>
            <b>{usd(usage.costUsd)}</b>
            <span>{usage.costUsd === 0 && usage.steps > 0 ? "provider reported no cost; set BOT_MODEL_PRICES on a custom endpoint" : `as ${modelsOf(usage) ?? "the provider"} priced it`}</span>
          </div>
        </li>
      </ul>
    </div>
  );
}

/** The panel's tabs. A Bot has all but Team; HQ has Team, Activity and Computer. */
export type PanelView = "activity" | "routines" | "library" | "computer" | "profile" | "team";

const BOT_TABS: readonly { id: PanelView; label: string; icon: IconName }[] = [
  { id: "activity", label: "Activity", icon: "list" },
  { id: "routines", label: "Routines", icon: "history" },
  { id: "library", label: "Library", icon: "folder" },
  { id: "computer", label: "Computer", icon: "monitor" },
  { id: "profile", label: "Profile", icon: "card" },
];
const HQ_TABS: readonly { id: PanelView; label: string; icon: IconName }[] = [
  { id: "team", label: "Team", icon: "person" },
  { id: "activity", label: "Activity", icon: "list" },
  { id: "computer", label: "Computer", icon: "monitor" },
];

/** The tab a member shows when asked for one it does not have. */
export function tabFor(member: Pick<Member, "kind">, view: PanelView): PanelView {
  const tabs = member.kind === "hq" ? HQ_TABS : BOT_TABS;
  return tabs.some((tab) => tab.id === view) ? view : (tabs[0]?.id ?? "activity");
}

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

/** The latest still frame of the team's screen, swapped in only once it has loaded. */
export function useScreen(member: Member): string | null {
  const url = posterUrl(member);
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
  // Keep this thread's previous frame up while the next one loads.
  return loaded.split("?t=")[0] === url.split("?t=")[0] ? loaded : null;
}

export function DetailsPanel({
  member,
  members,
  activity,
  view,
  onView,
  onClose,
  onSelect,
  onTakeover,
  onChanged,
  onHover,
  editRequest = 0,
}: {
  member: Member;
  members: readonly Member[];
  activity: readonly ActivityEvent[];
  view: PanelView;
  onView: (view: PanelView) => void;
  onClose: () => void;
  onSelect: (id: string) => void;
  onTakeover: () => void;
  onChanged: () => Promise<void>;
  onHover: (hover: Hover | null) => void;
  /** Bumped by the roster menu's "Edit profile"; the profile tab opens its form. */
  editRequest?: number;
}) {
  const tabs = member.kind === "hq" ? HQ_TABS : BOT_TABS;
  const tab = tabFor(member, view);
  const paused = member.status === "paused";
  return (
    <aside className="panel" aria-label="Details">
      <div className="panel-head">
        <span className="spacer" />
        <button type="button" className="icon-btn round" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="panel-hero">
        <div className="hero-face">
          <Mascot member={member} size={68} />
          {member.kind === "bot" ? (
            <button
              type="button"
              className="hero-edit"
              aria-label={`Edit ${member.name}'s profile`}
              title="Edit profile"
              onClick={() => onView("profile")}
            >
              <Icon name="edit" size={12} />
            </button>
          ) : null}
        </div>
        <h2>{member.name}</h2>
        <p className="hero-role">{member.title}</p>
        <p className={`hero-status ${paused ? "paused" : member.presence}`}>
          <i />
          {paused ? "Paused" : PRESENCE_LABEL[member.presence]}
          {member.action && !paused ? <span> · {member.action}</span> : null}
        </p>
      </div>
      <div className="tabs" role="tablist" aria-label={`${member.name}'s details`}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === tab}
            className={entry.id === tab ? "tab on" : "tab"}
            title={entry.label}
            onClick={() => onView(entry.id)}
          >
            <Icon name={entry.icon} size={15} />
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
      <div className="panel-body" key={`${member.id}:${tab}`}>
        {tab === "team" ? <TeamTab member={member} members={members} onSelect={onSelect} onHover={onHover} /> : null}
        {tab === "activity" ? <ActivityTab member={member} activity={activity} /> : null}
        {tab === "routines" ? <RoutinesTab member={member} onChanged={onChanged} /> : null}
        {tab === "library" ? <LibraryTab member={member} /> : null}
        {tab === "computer" ? <ComputerTab member={member} members={members} onTakeover={onTakeover} /> : null}
        {tab === "profile" ? <SettingsPanel key={member.id} member={member} onChanged={onChanged} editRequest={editRequest} /> : null}
      </div>
    </aside>
  );
}

/** What each kind of feed line looks like on the timeline. */
const ACTIVITY_ICON: Readonly<Record<string, IconName>> = {
  "job.assigned": "plus",
  "job.started": "play",
  "job.progress": "check",
  "job.artifact": "file",
  "job.blocked": "alert",
  "job.done": "check",
  "job.failed": "alert",
  "job.cancelled": "x",
  "job.learned": "spark",
  "job.rewound": "history",
  "job.stranded": "history",
  "job.crashed": "alert",
  "job.moved": "history",
  "memory.saved": "brain",
  "bot.hired": "person",
  "bot.updated": "edit",
  "bot.retired": "x",
  "computer.takeover": "monitor",
  "computer.handback": "monitor",
  "computer.restored": "monitor",
  "computer.failed": "alert",
  "team.message": "mail",
};

/** A feed line's headline: the job it is about, when the line names one in quotes. */
function headline(event: ActivityEvent): { title: string; detail: string } {
  const text = withoutEmoji(event.text);
  const quoted = /"([^"]{2,80})"/.exec(text)?.[1];
  if (quoted === undefined) return { title: text.length > 70 ? `${text.slice(0, 68)}…` : text, detail: "" };
  // The job is the heading; the line under it says what happened, without naming it twice.
  const detail = text.replace(`"${quoted}"`, "it").trim();
  return { title: quoted, detail };
}

/** 09.10.26, the way Muse dates its cards. */
const dateStamp = (at: string): string => {
  const date = new Date(at);
  return [date.getMonth() + 1, date.getDate(), date.getFullYear() % 100].map((part) => String(part).padStart(2, "0")).join(".");
};

function dayLabel(at: string): string {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** What the member has been doing, newest first, grouped by day: the feed as a timeline. */
function ActivityTab({ member, activity }: { member: Member; activity: readonly ActivityEvent[] }) {
  const [limit, setLimit] = useState(30);
  const events = useMemo(() => {
    const mine = activity.filter((event) =>
      member.kind === "hq" ? event.kind.startsWith("job.") || event.kind.startsWith("bot.") : event.botId === member.id,
    );
    return [...mine].sort((left, right) => right.at.localeCompare(left.at));
  }, [activity, member]);
  if (events.length === 0) {
    return <EmptyTab icon="list" title="Nothing yet" text={member.kind === "hq" ? "Work the team does shows up here." : `What ${member.name} does shows up here.`} />;
  }
  const shown = events.slice(0, limit);
  const days: { label: string; events: ActivityEvent[] }[] = [];
  for (const event of shown) {
    const label = dayLabel(event.at);
    const last = days[days.length - 1];
    if (last !== undefined && last.label === label) last.events.push(event);
    else days.push({ label, events: [event] });
  }
  return (
    <div className="timeline">
      {days.map((day) => (
        <section key={day.label}>
          <h3>{day.label}</h3>
          <ul>
            {day.events.map((event) => {
              const { title, detail } = headline(event);
              const bad = event.kind === "job.failed" || event.kind === "job.crashed" || event.kind === "computer.failed";
              return (
                <li key={event.id} className={bad ? "bad" : event.kind === "job.done" ? "good" : undefined}>
                  <span className="dot-icon">
                    <Icon name={ACTIVITY_ICON[event.kind] ?? "dot"} size={14} />
                  </span>
                  <div>
                    <b>{title}</b>
                    {detail === "" ? null : <span>{detail}</span>}
                    <time>{clock(new Date(event.at))}</time>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {events.length > limit ? (
        <button type="button" className="show-more" onClick={() => setLimit((value) => value + 30)}>
          Show more
        </button>
      ) : null}
    </div>
  );
}

function EmptyTab({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="empty-tab">
      <Icon name={icon} size={22} />
      <b>{title}</b>
      <span>{text}</span>
      {children}
    </div>
  );
}

function RoutinesTab({ member, onChanged }: { member: Member; onChanged: () => Promise<void> }) {
  const paused = member.status === "paused";
  const [editing, setEditing] = useState<Routine | null>(null);
  return (
    <>
      {member.routines.length === 0 ? (
        <EmptyTab icon="history" title="No routines" text={`Ask ${member.name} to do something every day or every week, and it shows up here.`} />
      ) : (
        <ul className="card-list">
          {member.routines.map((routine) => (
            <li key={routine.jobId}>
              <div>
                <b>{routine.title}</b>
                <span>{scheduleText(routine, paused)}</span>
              </div>
              <button type="button" className="btn small" onClick={() => setEditing(routine)} title="Change when it runs, or stop it">
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      <RoutineDialog routine={editing} onClose={() => setEditing(null)} onChanged={onChanged} />
    </>
  );
}

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/** Files the member saved, newest first: this week's, then older, a few at a time. */
function LibraryTab({ member }: { member: Member }) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  if (member.files.length === 0) {
    return <EmptyTab icon="folder" title="No files yet" text={`Screenshots, exports and drafts ${member.name} saves land here.`} />;
  }
  const week = Date.now() - 7 * 86_400_000;
  const groups = [
    { label: "This week", files: member.files.filter((file) => Date.parse(file.at) >= week) },
    { label: "Older", files: member.files.filter((file) => Date.parse(file.at) < week) },
  ].filter((group) => group.files.length > 0);
  return (
    <>
      {groups.map((group) => (
        <section key={group.label} className="library">
          <h3>{group.label}</h3>
          <ul className="card-list">
            {(more[group.label] ? group.files : group.files.slice(0, 5)).map((file) => {
              const href = `/bot/v1/artifacts/${encodeURIComponent(file.id)}`;
              return (
                <li key={file.id}>
                  <a href={href} target="_blank" rel="noopener noreferrer" className="file-row">
                    <span className="thumb">{IMAGE.test(file.mediaType) ? <img src={href} alt="" loading="lazy" /> : <Icon name="file" size={14} />}</span>
                    <span className="file-text">
                      <b>{file.name}</b>
                      <span>
                        {bytes(file.bytes)} · {shortWhen(file.at)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
            {group.files.length > 5 && !more[group.label] ? (
              <li className="show-more-row">
                <button type="button" className="show-more" onClick={() => setMore((value) => ({ ...value, [group.label]: true }))}>
                  Show more
                </button>
              </li>
            ) : null}
          </ul>
        </section>
      ))}
    </>
  );
}

function TeamTab({
  member,
  members,
  onSelect,
  onHover,
}: {
  member: Member;
  members: readonly Member[];
  onSelect: (id: string) => void;
  onHover: (hover: Hover | null) => void;
}) {
  const bots = members.filter((entry) => entry.kind === "bot");
  const waiting = bots.filter((bot) => bot.presence === "waiting" || bot.pending > 0);
  return (
    <>
      {waiting.length === 0 ? null : (
        <section>
          <h3>Waiting on you</h3>
          <ul className="card-list">
            {waiting.map((bot) => (
              <li key={bot.id}>
                <button type="button" className="team-row" onClick={() => onSelect(bot.id)}>
                  <Avatar member={bot} size={26} presence="waiting" onHover={onHover} />
                  <span className="file-text">
                    <b>{bot.name}</b>
                    <span>{bot.action ?? "Needs a decision"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Team</h3>
        {bots.length === 0 ? (
          <EmptyTab icon="person" title="No Bots yet" text="Ask HQ to hire one, or press + in the sidebar." />
        ) : (
          <ul className="card-list">
            {bots.map((bot) => (
              <li key={bot.id}>
                <button type="button" className="team-row" onClick={() => onSelect(bot.id)}>
                  <Avatar member={bot} size={26} onHover={onHover} />
                  <span className="file-text">
                    <b>{bot.name}</b>
                    <span>
                      {bot.status === "paused" ? "Paused" : PRESENCE_LABEL[bot.presence]} · {bot.action ?? bot.title}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <UsageSection member={member} />
    </>
  );
}

/** The screen, awake or asleep. Asleep, a press wakes the browser; awake, it opens the computer. */
function ComputerTab({ member, members, onTakeover }: { member: Member; members: readonly Member[]; onTakeover: () => void }) {
  const asleep = member.computer.browser !== "on" && member.computer.browser !== "starting";
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wake = async () => {
    setWaking(true);
    setError(null);
    try {
      const response = await api(`/bot/v1/bots/${encodeURIComponent(member.kind === "hq" ? "hq" : member.id)}/computer/browser`, { method: "POST" });
      if (!response.ok) setError(await errorMessage(response, "Could not wake the computer."));
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not wake the computer.");
    } finally {
      setWaking(false);
    }
  };
  return (
    <>
      {asleep && member.computer.control === null && !member.computer.active ? (
        <div className="asleep">
          <SleepingFace />
          <b>Computer is asleep</b>
          <button type="button" className="btn small" disabled={waking} onClick={() => void wake()}>
            {waking ? "Waking…" : "Wake"}
          </button>
          {error === null ? null : <span className="error-text">{error}</span>}
        </div>
      ) : (
        <ScreenPreview member={member} members={members} onTakeover={onTakeover} />
      )}
      <p className="screen-caption">
        {member.kind === "hq" ? "The team's screen" : `${member.name}'s screen`}
        {member.computer.kind ? <span className="screen-kind"> · {member.computer.kind}</span> : null}
      </p>
    </>
  );
}

/** A small grey mascot, eyes shut, for a computer that is not running. */
function SleepingFace() {
  return (
    <svg className="sleeping" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M24 8c8 9 13 14.6 13 21a13 13 0 0 1-26 0c0-6.4 5-12 13-21Z" fill="currentColor" />
      <path d="M17.5 30.5q2.2 1.8 4.4 0M26.1 30.5q2.2 1.8 4.4 0" fill="none" stroke="var(--side)" strokeWidth={2} strokeLinecap="round" />
      <text x="35" y="12" className="z1">z</text>
      <text x="40" y="6" className="z2">z</text>
    </svg>
  );
}

/** What the team's browser is up to right now, for its caption and badge. */
function usingScreen(member: Member, members: readonly Member[]): Member | null {
  if (member.kind === "bot") return member.computer.active ? member : null;
  return members.find((entry) => entry.kind === "bot" && entry.computer.active) ?? null;
}

/**
 * The team's one screen, from any thread: a still of the browser, and the way
 * into the full computer, where it is live. HQ's desk and every Bot's
 * panel show the same browser, so a sign-in made for one Bot is there for all.
 */
function ScreenPreview({
  member,
  members,
  onTakeover,
}: {
  member: Member;
  members: readonly Member[];
  onTakeover: () => void;
}) {
  // The still frame of this member's own tab, refreshed as it works. The shared
  // browser has one live picture (the front tab), so a thumbnail per Bot shows
  // stills instead: that way two Bots working at once each show their own tab.
  const screen = useScreen(member);
  const working = usingScreen(member, members);

  return (
    <>
      <button type="button" className="screen" aria-label="Open the team's computer" onClick={onTakeover}>
        <Wallpaper />
        {screen === null ? null : (
          // A live, authenticated, uncached frame: next/image would only get in the way.
          <img src={screen} alt="" />
        )}
        {member.computer.control !== null ? (
          <span className="screen-live">{`${member.computer.control.by} has control`}</span>
        ) : working !== null ? (
          <span className="screen-live">{member.kind === "hq" ? `${working.name} is working` : "Working"}</span>
        ) : null}
        <span className="dock">
          <Avatar member={member} size={10} />
          <i />
          <i />
          <i />
        </span>
      </button>
    </>
  );
}

function SettingsPanel({
  member,
  onChanged,
  editRequest,
}: {
  member: Member;
  onChanged: () => Promise<void>;
  editRequest: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // "Edit profile" from the roster menu lands straight in the form.
  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);
  const profile = member.profile;
  const paused = member.status === "paused";
  const [open, setOpen] = useState<"soul" | "playbook" | null>(null);

  /** Saves the Bot's name, job, and instructions. The next message and the next job use them. */
  const saveProfile = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/bot/v1/bots/${encodeURIComponent(member.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: field("name"), role: field("role"), persona: field("persona") }),
      });
      if (response.ok) {
        await onChanged();
        setEditing(false);
      } else {
        setError(await errorMessage(response, "Could not save the profile."));
      }
    } catch (caught) {
      if (!(caught instanceof SignedOutError)) setError("Could not save the profile.");
    } finally {
      setBusy(false);
    }
  };

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

  if (editing && profile !== null) {
    return (
      <form
        className="edit-profile"
        onSubmit={(event) => {
          event.preventDefault();
          void saveProfile(event.currentTarget);
        }}
      >
        <h3>Edit profile</h3>
        <label>
          Name
          <input name="name" defaultValue={member.name} maxLength={40} required autoComplete="off" />
        </label>
        <label>
          Job
          <input name="role" defaultValue={member.title} maxLength={120} required autoComplete="off" />
        </label>
        <label>
          How it should work
          <textarea name="persona" defaultValue={profile.persona} rows={12} minLength={20} maxLength={4000} required />
        </label>
        <p className="faint">Applies from the next message and the next job. A job already running keeps what it started with.</p>
        {error === null ? null : <p className="error-text">{error}</p>}
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      {profile === null ? null : (
        <div className="identity">
          <b>{member.name}</b>
          <button type="button" className="btn wide" onClick={() => setEditing(true)}>
            <Icon name="edit" size={13} /> Edit
          </button>
        </div>
      )}

      {profile === null ? null : (
        <>
          <div className="soul-cards">
            <button type="button" className={open === "soul" ? "soul on" : "soul"} onClick={() => setOpen(open === "soul" ? null : "soul")}>
              <b>Soul</b>
              <small>How it works</small>
              <span>
                <time>{dateStamp(profile.hiredAt)}</time>
                <Icon name="chev" size={13} />
              </span>
            </button>
            <button type="button" className={open === "playbook" ? "playbook on" : "playbook"} onClick={() => setOpen(open === "playbook" ? null : "playbook")}>
              <b>Playbook</b>
              <small>{profile.playbook.length === 1 ? "1 lesson" : `${profile.playbook.length} lessons`}</small>
              <span>
                <time>{profile.stats.jobsCompleted} done</time>
                <Icon name="chev" size={13} />
              </span>
            </button>
          </div>
          {open === "soul" ? (
            <div className="section reveal">
              <h3>{`How ${member.name} works`}</h3>
              <p className="prose">{profile.persona}</p>
            </div>
          ) : null}
          {open !== "playbook" ? null : (
          <div className="section reveal">
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
          )}
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
      <UsageSection member={member} />
      <p className="faint">{`To retire ${member.name}, ask HQ. It will ask for your approval first.`}</p>
    </>
  );
}
