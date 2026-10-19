"use client";

import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  DotIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  IdCardIcon,
  ListIcon,
  type LucideIcon,
  MailIcon,
  MonitorIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { api, errorMessage, SignedOutError } from "./api";
import { Avatar } from "./avatar";
import { Mascot } from "./mascot";
import { posterUrl } from "./computer/browser-app";
import { bytes, clock, PRESENCE_LABEL, scheduleText, shortWhen, withoutEmoji } from "./format";
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
    <Section title="Usage" quiet>
      <ul className="m-0 list-none p-0">
        <ListRow icon={DotIcon} title={models.length === 0 ? "Model not reported" : models.length === 1 ? models[0]![0] : `${models.length} models`}>
          {models.length > 1 ? models.map(([model, steps]) => `${model} ×${steps}`).join(" · ") : `${usage.steps} model ${usage.steps === 1 ? "step" : "steps"}`}
        </ListRow>
        <ListRow icon={DotIcon} title={`${tokens(usage.inputTokens)} in · ${tokens(usage.outputTokens)} out`}>
          {usage.cacheReadTokens > 0 ? `${tokens(usage.cacheReadTokens)} read from cache` : "no cache reads"}
          {(usage.cacheWriteTokens ?? 0) > 0 ? ` · ${tokens(usage.cacheWriteTokens ?? 0)} written` : ""}
        </ListRow>
        <ListRow icon={DotIcon} title={usd(usage.costUsd)}>
          {usage.costUsd === 0 && usage.steps > 0 ? "provider reported no cost; set model prices in Settings, Spend, on a custom endpoint" : `as ${modelsOf(usage) ?? "the provider"} priced it`}
        </ListRow>
      </ul>
    </Section>
  );
}

/**
 * A titled block of the panel body. `quiet` is the small grey label used for
 * reference sections (Usage, Record); otherwise the title reads as a heading.
 */
function Section({ title, quiet = false, className, children }: { title?: string; quiet?: boolean; className?: string; children: ReactNode }) {
  return (
    <section className={cn("mb-[18px]", className)}>
      {title === undefined ? null : (
        <h3 className={quiet ? "m-0 mb-1.5 text-[11.5px] font-medium text-faint" : "m-0 mb-2 text-[13px] font-semibold text-foreground"}>{title}</h3>
      )}
      {children}
    </section>
  );
}

/** A line of a plain list: an icon, a bold line, and a quieter one under it. */
function ListRow({ icon: RowIcon, title, children }: { icon: LucideIcon; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-[9px] py-[5px]">
      <RowIcon className="mt-px size-[15px] shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <b className="block text-[12.5px] font-medium [overflow-wrap:anywhere]">{title}</b>
        {children === undefined ? null : <span className="block text-[11.5px] text-muted-foreground">{children}</span>}
      </div>
    </li>
  );
}

/** A rounded card of rows: routines, files, the team. */
function CardList({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none rounded-[14px] border border-border bg-card p-1">{children}</ul>;
}

/** One row of a card list; rows after the first are divided by a hairline. */
function CardRow({ className, children }: { className?: string; children: ReactNode }) {
  return <li className={cn("flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 [&+&]:rounded-none [&+&]:border-t [&+&]:border-border", className)}>{children}</li>;
}

/** A row's name and the line under it, clamped to two lines. */
function RowText({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <span className="block min-w-0 flex-1">
      <b className="block truncate text-[12.5px] font-medium group-hover/row:underline group-hover/row:underline-offset-2">{title}</b>
      {children === undefined ? null : (
        <span className="line-clamp-2 block text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">{children}</span>
      )}
    </span>
  );
}

/** The panel's tabs. A Bot has all but Team; HQ has Team, Activity and Computer. */
export type PanelView = "activity" | "routines" | "library" | "computer" | "profile" | "team";

const BOT_TABS: readonly { id: PanelView; label: string; icon: LucideIcon }[] = [
  { id: "activity", label: "Activity", icon: ListIcon },
  { id: "routines", label: "Routines", icon: HistoryIcon },
  { id: "library", label: "Library", icon: FolderIcon },
  { id: "computer", label: "Computer", icon: MonitorIcon },
  { id: "profile", label: "Profile", icon: IdCardIcon },
];
const HQ_TABS: readonly { id: PanelView; label: string; icon: LucideIcon }[] = [
  { id: "team", label: "Team", icon: UserIcon },
  { id: "activity", label: "Activity", icon: ListIcon },
  { id: "computer", label: "Computer", icon: MonitorIcon },
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
    <svg className="absolute inset-0 size-full" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
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
  const dot = paused ? "paused" : member.presence;
  return (
    // The slot in console.tsx clips and slides; the panel keeps its own width inside it,
    // and fills the slot where it is an overlay (narrow windows).
    <aside
      className="panel absolute inset-y-0 right-0 flex w-(--panel-w,300px) min-w-0 flex-col border-l border-border bg-panel max-[1080px]:w-full max-[1080px]:shadow-float"
      aria-label="Details"
    >
      <div className="flex h-12 flex-none items-center justify-end gap-0.5 px-2.5">
        <Button variant="outline" size="icon" className="size-[30px] rounded-full bg-card" aria-label="Close" title="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="flex flex-none flex-col items-center px-4 pb-3.5 text-center">
        <div className="hero-face group/face relative rounded-full p-1.5">
          <Mascot member={member} size={68} />
          {member.kind === "bot" ? (
            <button
              type="button"
              className="absolute right-0.5 bottom-1 z-1 grid size-[22px] cursor-pointer place-items-center rounded-full border border-input bg-card text-muted-foreground opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.12)] transition-[opacity,transform] duration-150 group-hover/face:opacity-100 hover:scale-[1.08] hover:text-foreground focus-visible:opacity-100"
              aria-label={`Edit ${member.name}'s profile`}
              title="Edit profile"
              onClick={() => onView("profile")}
            >
              <PencilIcon className="size-3" />
            </button>
          ) : null}
        </div>
        <h2 className="m-0 mt-1 text-base font-semibold tracking-[-0.01em]">{member.name}</h2>
        <p className="m-0 mt-0.5 max-w-full truncate text-xs text-faint">{member.title}</p>
        <p className="m-0 mt-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
          <i
            className={cn(
              "size-[7px] flex-none rounded-full bg-faint",
              (dot === "working" || dot === "thinking") && "bg-success motion-safe:animate-panel-pulse",
              dot === "waiting" && "bg-warning",
              dot === "blocked" && "bg-destructive",
              (dot === "idle" || dot === "done") && "bg-success opacity-70",
            )}
          />
          {paused ? "Paused" : PRESENCE_LABEL[member.presence]}
          {member.action && !paused ? <span className="truncate"> · {member.action}</span> : null}
        </p>
      </div>
      <Tabs value={tab} onValueChange={(value) => onView(value as PanelView)} className="min-h-0 flex-1 gap-0">
        <TabsList aria-label={`${member.name}'s details`} className="mx-3 mb-1 flex w-auto gap-0.5 rounded-xl bg-secondary group-data-horizontal/tabs:h-9">
          {tabs.map((entry) => (
            <TabsTrigger
              key={entry.id}
              value={entry.id}
              title={entry.label}
              className="group/tab h-[30px] min-w-0 rounded-[9px] text-xs text-muted-foreground transition-[background-color,color,flex-grow] duration-200 ease-[cubic-bezier(0.2,0,0,1)] data-active:grow-[2.4] data-active:bg-card data-active:text-foreground data-active:shadow-[0_1px_3px_rgba(0,0,0,0.12)] dark:data-active:border-transparent dark:data-active:bg-card [&_svg:not([class*='size-'])]:size-[15px]"
            >
              <entry.icon />
              <span className="hidden whitespace-nowrap group-data-active/tab:inline">{entry.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent
          value={tab}
          key={`${member.id}:${tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-5 text-[13px] motion-safe:animate-panel-in"
        >
          {tab === "team" ? <TeamTab member={member} members={members} onSelect={onSelect} onHover={onHover} /> : null}
          {tab === "activity" ? <ActivityTab member={member} activity={activity} /> : null}
          {tab === "routines" ? <RoutinesTab member={member} onChanged={onChanged} /> : null}
          {tab === "library" ? <LibraryTab member={member} /> : null}
          {tab === "computer" ? <ComputerTab member={member} members={members} onTakeover={onTakeover} /> : null}
          {tab === "profile" ? <SettingsPanel key={member.id} member={member} onChanged={onChanged} editRequest={editRequest} /> : null}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

/** What each kind of feed line looks like on the timeline. */
const ACTIVITY_ICON: Readonly<Record<string, LucideIcon>> = {
  "job.assigned": PlusIcon,
  "job.started": PlayIcon,
  "job.progress": CheckIcon,
  "job.artifact": FileIcon,
  "job.blocked": TriangleAlertIcon,
  "job.done": CheckIcon,
  "job.failed": TriangleAlertIcon,
  "job.cancelled": XIcon,
  "job.learned": SparklesIcon,
  "job.rewound": HistoryIcon,
  "job.stranded": HistoryIcon,
  "job.crashed": TriangleAlertIcon,
  "job.moved": HistoryIcon,
  "memory.saved": BrainIcon,
  "bot.hired": UserIcon,
  "bot.updated": PencilIcon,
  "bot.retired": XIcon,
  "computer.takeover": MonitorIcon,
  "computer.handback": MonitorIcon,
  "computer.restored": MonitorIcon,
  "computer.failed": TriangleAlertIcon,
  "team.message": MailIcon,
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
    return <EmptyTab icon={ListIcon} title="Nothing yet" text={member.kind === "hq" ? "Work the team does shows up here." : `What ${member.name} does shows up here.`} />;
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
    <div>
      {days.map((day) => (
        <Section key={day.label} title={day.label}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {day.events.map((event) => {
              const { title, detail } = headline(event);
              const bad = event.kind === "job.failed" || event.kind === "job.crashed" || event.kind === "computer.failed";
              const EventIcon = ACTIVITY_ICON[event.kind] ?? DotIcon;
              return (
                <li key={event.id} className="flex items-start gap-[11px]">
                  <span
                    className={cn(
                      "grid size-[30px] flex-none place-items-center rounded-[9px] bg-secondary text-muted-foreground",
                      bad && "text-destructive",
                      event.kind === "job.done" && "text-success",
                    )}
                  >
                    <EventIcon className="size-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <b className="text-[12.5px] font-semibold [overflow-wrap:anywhere]">{title}</b>
                    {detail === "" ? null : <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{detail}</span>}
                    <time className="mt-px text-[11px] text-faint tabular-nums">{clock(new Date(event.at))}</time>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
      {events.length > limit ? <ShowMore onClick={() => setLimit((value) => value + 30)} /> : null}
    </div>
  );
}

function EmptyTab({ icon: TabIcon, title, text, children }: { icon: LucideIcon; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-7 text-center text-muted-foreground">
      <TabIcon className="mb-1 size-[22px] text-muted-foreground" />
      <b className="text-[13px] font-semibold text-foreground">{title}</b>
      <span className="max-w-[240px] text-xs">{text}</span>
      {children}
    </div>
  );
}

function ShowMore({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="mx-auto mt-1 flex text-xs font-normal text-muted-foreground" onClick={onClick}>
      Show more
    </Button>
  );
}

function RoutinesTab({ member, onChanged }: { member: Member; onChanged: () => Promise<void> }) {
  const paused = member.status === "paused";
  const [editing, setEditing] = useState<Routine | null>(null);
  return (
    <>
      {member.routines.length === 0 ? (
        <EmptyTab icon={HistoryIcon} title="No routines" text={`Ask ${member.name} to do something every day or every week, and it shows up here.`} />
      ) : (
        <CardList>
          {member.routines.map((routine) => (
            <CardRow key={routine.jobId}>
              <RowText title={routine.title}>{scheduleText(routine, paused)}</RowText>
              <Button variant="secondary" size="xs" className="rounded-full" onClick={() => setEditing(routine)} title="Change when it runs, or stop it">
                Edit
              </Button>
            </CardRow>
          ))}
        </CardList>
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
    return <EmptyTab icon={FolderIcon} title="No files yet" text={`Screenshots, exports and drafts ${member.name} saves land here.`} />;
  }
  const week = Date.now() - 7 * 86_400_000;
  const groups = [
    { label: "This week", files: member.files.filter((file) => Date.parse(file.at) >= week) },
    { label: "Older", files: member.files.filter((file) => Date.parse(file.at) < week) },
  ].filter((group) => group.files.length > 0);
  return (
    <>
      {groups.map((group) => (
        <Section key={group.label} title={group.label}>
          <CardList>
            {(more[group.label] ? group.files : group.files.slice(0, 5)).map((file) => {
              const href = `/bot/v1/artifacts/${encodeURIComponent(file.id)}`;
              return (
                <CardRow key={file.id}>
                  <a href={href} target="_blank" rel="noopener noreferrer" className="group/row flex w-full min-w-0 items-center gap-2.5 text-left text-inherit no-underline">
                    <span className="grid size-[26px] flex-none place-items-center overflow-hidden rounded-md border border-border bg-secondary text-muted-foreground">
                      {IMAGE.test(file.mediaType) ? <img src={href} alt="" loading="lazy" className="size-full object-cover object-top-left" /> : <FileIcon className="size-3.5" />}
                    </span>
                    <RowText title={file.name}>
                      {bytes(file.bytes)} · {shortWhen(file.at)}
                    </RowText>
                  </a>
                </CardRow>
              );
            })}
            {group.files.length > 5 && !more[group.label] ? (
              <CardRow className="justify-center p-0.5">
                <ShowMore onClick={() => setMore((value) => ({ ...value, [group.label]: true }))} />
              </CardRow>
            ) : null}
          </CardList>
        </Section>
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
        <Section title="Waiting on you">
          <CardList>
            {waiting.map((bot) => (
              <CardRow key={bot.id}>
                <TeamRow bot={bot} presence="waiting" onSelect={onSelect} onHover={onHover}>
                  {bot.action ?? "Needs a decision"}
                </TeamRow>
              </CardRow>
            ))}
          </CardList>
        </Section>
      )}
      <Section title="Team">
        {bots.length === 0 ? (
          <EmptyTab icon={UserIcon} title="No Bots yet" text="Ask HQ to hire one, or press + in the sidebar." />
        ) : (
          <CardList>
            {bots.map((bot) => (
              <CardRow key={bot.id}>
                <TeamRow bot={bot} onSelect={onSelect} onHover={onHover}>
                  {bot.status === "paused" ? "Paused" : PRESENCE_LABEL[bot.presence]} · {bot.action ?? bot.title}
                </TeamRow>
              </CardRow>
            ))}
          </CardList>
        )}
      </Section>
      <UsageSection member={member} />
    </>
  );
}

/** A teammate in HQ's team list: face, name, and what they are up to; opens their thread. */
function TeamRow({
  bot,
  presence,
  onSelect,
  onHover,
  children,
}: {
  bot: Member;
  presence?: Member["presence"];
  onSelect: (id: string) => void;
  onHover: (hover: Hover | null) => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="group/row flex w-full min-w-0 items-center gap-2.5 text-left" onClick={() => onSelect(bot.id)}>
      <Avatar member={bot} size={26} {...(presence === undefined ? {} : { presence })} onHover={onHover} />
      <RowText title={bot.name}>{children}</RowText>
    </button>
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
        <div className="flex aspect-16/12 w-full flex-col items-center justify-center gap-1.5 rounded-[14px] border border-border bg-secondary">
          <SleepingFace />
          <b className="text-[12.5px] font-semibold">Computer is asleep</b>
          <Button variant="outline" size="xs" className="rounded-full" disabled={waking} onClick={() => void wake()}>
            {waking ? "Waking…" : "Wake"}
          </Button>
          {error === null ? null : <span className="text-xs text-destructive">{error}</span>}
        </div>
      ) : (
        <ScreenPreview member={member} members={members} onTakeover={onTakeover} />
      )}
      <p className="m-0 mt-2 mb-[18px] text-center text-[11.5px] text-muted-foreground">
        {member.kind === "hq" ? "The team's screen" : `${member.name}'s screen`}
        {member.computer.kind ? <span className="text-faint"> · {member.computer.kind}</span> : null}
      </p>
    </>
  );
}

/** A small grey mascot, eyes shut, for a computer that is not running. */
function SleepingFace() {
  return (
    <svg className="size-11 overflow-visible text-faint" viewBox="0 0 48 48" aria-hidden="true">
      <path
        d="M24 8c8 9 13 14.6 13 21a13 13 0 0 1-26 0c0-6.4 5-12 13-21Z"
        fill="currentColor"
        className="origin-[50%_90%] [transform-box:fill-box] motion-safe:animate-panel-doze"
      />
      <path d="M17.5 30.5q2.2 1.8 4.4 0M26.1 30.5q2.2 1.8 4.4 0" fill="none" stroke="var(--sidebar)" strokeWidth={2} strokeLinecap="round" />
      <text x="35" y="12" className="fill-faint text-[7px] font-semibold motion-safe:animate-panel-drift">
        z
      </text>
      <text x="40" y="6" className="fill-faint text-[7px] font-semibold motion-safe:animate-panel-drift motion-safe:[animation-delay:1.6s]">
        z
      </text>
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
      <button
        type="button"
        className="relative block aspect-16/10 w-full cursor-zoom-in overflow-hidden rounded-[14px] border border-input bg-[#1d1d1f]"
        aria-label="Open the team's computer"
        onClick={onTakeover}
      >
        <Wallpaper />
        {screen === null ? null : (
          // A live, authenticated, uncached frame: next/image would only get in the way. The frame
          // is the page at its own shape: fit the whole of it, top-aligned, never cropped.
          <img src={screen} alt="" className="absolute inset-0 size-full object-contain object-top" />
        )}
        {member.computer.control !== null || working !== null ? (
          <span className="absolute top-[7px] left-[7px] flex items-center gap-1 rounded-md bg-black/45 px-1.5 py-px text-[10px] text-white before:size-[5px] before:rounded-full before:bg-brand before:content-['']">
            {member.computer.control !== null
              ? `${member.computer.control.by} has control`
              : member.kind === "hq"
                ? `${working?.name ?? "A Bot"} is working`
                : "Working"}
          </span>
        ) : null}
        <span className="absolute bottom-[7px] left-1/2 flex -translate-x-1/2 items-center gap-[3px] rounded-[7px] bg-white/35 px-[5px] py-[3px] backdrop-blur-[6px]">
          <Avatar member={member} size={10} />
          <i className="block size-[9px] rounded-[3px] bg-white/85" />
          <i className="block size-[9px] rounded-[3px] bg-[rgba(40,40,40,0.6)]" />
          <i className="block size-[9px] rounded-[3px] bg-white/85" />
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
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void saveProfile(event.currentTarget);
        }}
      >
        <h3 className="m-0 text-[13px] font-semibold">Edit profile</h3>
        <ProfileField label="Name" htmlFor={`${member.id}-name`}>
          <Input id={`${member.id}-name`} name="name" defaultValue={member.name} maxLength={40} required autoComplete="off" />
        </ProfileField>
        <ProfileField label="Job" htmlFor={`${member.id}-role`}>
          <Input id={`${member.id}-role`} name="role" defaultValue={member.title} maxLength={120} required autoComplete="off" />
        </ProfileField>
        <ProfileField label="How it should work" htmlFor={`${member.id}-persona`}>
          <Textarea
            id={`${member.id}-persona`}
            name="persona"
            defaultValue={profile.persona}
            rows={12}
            minLength={20}
            maxLength={4000}
            required
            className="field-sizing-fixed resize-y text-[12.5px]"
          />
        </ProfileField>
        <p className="m-0 text-[11.5px] leading-[1.45] text-faint">Applies from the next message and the next job. A job already running keeps what it started with.</p>
        {error === null ? null : <p className="m-0 text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      {profile === null ? null : (
        <div className="mb-[18px] flex flex-col gap-2.5 rounded-[14px] bg-secondary p-3">
          <b className="text-[13px] font-semibold">{member.name}</b>
          <Button variant="outline" className="w-full rounded-full bg-card dark:bg-card" onClick={() => setEditing(true)}>
            <PencilIcon data-icon="inline-start" /> Edit
          </Button>
        </div>
      )}

      {profile === null ? null : (
        <>
          <div className="mb-[18px] grid grid-cols-2 gap-2.5">
            <SoulCard
              tone="soul"
              title="Soul"
              note="How it works"
              stamp={dateStamp(profile.hiredAt)}
              open={open === "soul"}
              onClick={() => setOpen(open === "soul" ? null : "soul")}
            />
            <SoulCard
              tone="playbook"
              title="Playbook"
              note={profile.playbook.length === 1 ? "1 lesson" : `${profile.playbook.length} lessons`}
              stamp={`${profile.stats.jobsCompleted} done`}
              open={open === "playbook"}
              onClick={() => setOpen(open === "playbook" ? null : "playbook")}
            />
          </div>
          {open === "soul" ? (
            <Section title={`How ${member.name} works`} quiet className="motion-safe:animate-panel-in">
              <p className="m-0 text-[12.5px] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{profile.persona}</p>
            </Section>
          ) : null}
          {open !== "playbook" ? null : (
            <Section title="Playbook" quiet className="motion-safe:animate-panel-in">
              <ul className="m-0 list-none p-0">
                {profile.playbook.length === 0 ? (
                  <li className="py-0.5 text-xs text-faint">Nothing learned yet</li>
                ) : (
                  profile.playbook.map((lesson) => <ListRow key={lesson} icon={BrainIcon} title={lesson} />)
                )}
              </ul>
            </Section>
          )}
          <Section title="Record" quiet>
            <p className="m-0 text-[12.5px] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
              {`${profile.stats.jobsCompleted} done · ${profile.stats.jobsFailed} failed · joined ${shortWhen(profile.hiredAt)}`}
              {profile.createdBy === null ? "" : ` · created by ${profile.createdBy}`}
            </p>
          </Section>
        </>
      )}

      <Section>
        <Button variant="secondary" disabled={busy} onClick={() => void toggle()}>
          {paused ? `Resume ${member.name}` : `Pause ${member.name}`}
        </Button>
        {error === null ? null : <p className="m-0 mt-1.5 text-xs text-destructive">{error}</p>}
      </Section>
      <UsageSection member={member} />
      <p className="m-0 text-[11.5px] text-faint">{`To retire ${member.name}, ask HQ. It will ask for your approval first.`}</p>
    </>
  );
}

/** A labelled control in the profile form. */
function ProfileField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** One of the two gradient cards on a profile: the Bot's soul (how it works) and its playbook. */
function SoulCard({
  tone,
  title,
  note,
  stamp,
  open,
  onClick,
}: {
  tone: "soul" | "playbook";
  title: string;
  note: string;
  stamp: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className={cn(
        "relative flex aspect-[1/0.92] flex-col overflow-hidden rounded-[18px] p-3 text-left text-white transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.2,0,0,1)] hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(0,0,0,0.18)]",
        "after:pointer-events-none after:absolute after:inset-0 after:bg-[radial-gradient(120%_80%_at_80%_10%,rgba(255,255,255,0.28),transparent_60%)] after:content-['']",
        tone === "soul" ? "bg-[linear-gradient(150deg,#e2475b,#a8152b)]" : "bg-[linear-gradient(150deg,#4c63e0,#222a8a)]",
        open && "-translate-y-0.5",
      )}
    >
      <b className="text-[13px] font-bold tracking-[0.04em] uppercase">{title}</b>
      <small className="text-[9.5px] tracking-[0.08em] uppercase opacity-75">{note}</small>
      <span className="mt-auto flex items-center justify-between font-mono text-[11px] opacity-90">
        <time>{stamp}</time>
        <ChevronDownIcon className={cn("size-[13px] transition-transform", open && "rotate-180")} />
      </span>
    </button>
  );
}
