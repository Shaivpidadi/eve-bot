"use client";

import type { InputRequest, InputResolution } from "eve/client";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  FilePenIcon,
  GitBranchIcon,
  GlobeIcon,
  HandIcon,
  HistoryIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  PaperclipIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

import { AskCard } from "./ask-card";
import { Avatar } from "./avatar";
import { clock, dividerWhen, needsDivider } from "./format";
import { api } from "./api";
import { Icon } from "./icons";
import type { Busy } from "./chat";
import { LiveAvatar } from "./live-avatar";
import { MentionText, useTeam } from "./mentions";
import { Prose } from "./prose";
import type { RoomSnapshot, RoomStore, StepsItem, TimelineItem } from "./room-store";
import { suggestionsFor } from "./suggestions";
import type { Member } from "./types";

const STEP_WORDS: Readonly<Record<string, string>> = {
  "job.assigned": "Assigned",
  "job.started": "Started",
  "job.progress": "Did",
  "job.artifact": "Saved",
  "job.blocked": "Waiting",
  "job.done": "Finished",
  "job.failed": "Failed",
  "job.cancelled": "Cancelled",
  "job.crashed": "Crashed",
  "job.stranded": "Restarted",
  "job.moved": "Moved",
  "job.rewound": "Rewound",
  "job.learned": "Learned",
};

/** How close to the bottom still counts as following the conversation. */
const PINNED_PX = 90;

/**
 * The answer the server recorded for a request whose resolution never reaches
 * the room's stream, as requests raised inside background work do.
 */
function answeredResolution(member: Member, request: InputRequest): InputResolution | undefined {
  const answered = member.answered[request.requestId];
  if (answered === undefined) return undefined;
  return {
    kind: request.kind,
    requestId: request.requestId,
    outcome: answered.outcome,
    ...(answered.optionId === null ? {} : { response: { requestId: request.requestId, optionId: answered.optionId } }),
  } as InputResolution;
}

export function Transcript({
  member,
  room,
  timeline,
  busy,
  user,
  store,
  onOpenComputer,
}: {
  member: Member;
  room: RoomSnapshot;
  timeline: readonly TimelineItem[];
  /** Teammates on work for this thread; see `busyIn` in chat.tsx. */
  busy: readonly Busy[];
  user: string;
  store: RoomStore;
  onOpenComputer: (requestId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const team = useTeam();
  const faceFor = (face: string | undefined) =>
    face === undefined ? undefined : team.find((entry) => entry.id === face || entry.name.toLowerCase() === face.toLowerCase());
  const pinned = useRef(true);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set());
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [showMore, setShowMore] = useState(false);
  // What was already in the thread when it opened appears with it; only what arrives after eases in.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  // Keep the latest message in view, unless the reader scrolled up to look back.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const toggleSteps = (key: string) =>
    setOpenSteps((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const answer = async (requestId: string, optionId: string | undefined) => {
    const sent = await store.answer(requestId, optionId, notes.get(requestId) ?? "");
    if (!sent) return;
    setNotes((current) => {
      const next = new Map(current);
      next.delete(requestId);
      return next;
    });
  };

  let body: ReactNode = null;
  if (room.loaded && timeline.length === 0 && room.optimistic.length === 0) {
    body = (
      <EmptyChat
        member={member}
        showMore={showMore}
        onMore={() => setShowMore(true)}
        onSuggest={(text) => void store.send(text)}
      />
    );
  } else if (timeline.length > 0 || room.optimistic.length > 0) {
    const rows: ReactNode[] = [];
    let lastAt: string | null = null;

    for (const item of timeline) {
      if (needsDivider(lastAt, item.at)) {
        rows.push(
          <div key={`divider:${item.key}`} className="divider">
            {dividerWhen(item.at)}
          </div>,
        );
      }
      lastAt = item.at;

      switch (item.kind) {
        case "you":
          rows.push(
            <div key={item.key} className="msg-wrap you">
              <div className="msg you">
                <MentionText text={item.text} />
              </div>
              <RememberButton text={item.text} />
            </div>,
          );
          break;
        case "bot":
          rows.push(
            <div key={item.key} className="msg-wrap bot">
              <div className="msg bot">
                <Prose text={item.text} />
              </div>
              <RememberButton text={item.text} />
            </div>,
          );
          break;
        case "peer": {
          const sender = team.find((entry) => entry.name.toLowerCase() === item.from.toLowerCase());
          rows.push(
            <div key={item.key} className="msg-wrap peer">
              {sender === undefined ? null : <Avatar member={sender} size={24} />}
              <div className="msg bot peer">
                <span className="peer-name">{item.from}</span>
                <Prose text={item.text} />
              </div>
            </div>,
          );
          break;
        }
        case "notice":
          rows.push(
            <div key={item.key} className={item.tone === "error" ? "notice error" : "notice"}>
              {faceFor(item.face) === undefined ? <Icon name={item.icon} size={13} /> : <Avatar member={faceFor(item.face)!} size={16} />}
              <span>{item.label}</span>
              {item.detail ? <b>{item.detail}</b> : null}
              {item.action === "start-over" ? (
                <button type="button" className="btn" onClick={() => void store.startOver()}>
                  Start over
                </button>
              ) : null}
              {item.action === "open-connectors" ? (
                <button type="button" className="btn primary" onClick={() => window.location.assign("/bot#connectors")}>
                  Open connectors
                </button>
              ) : null}
            </div>,
          );
          break;
        case "ask": {
          const request = room.asks.get(item.requestId);
          if (request === undefined) break;
          rows.push(
            <AskCard
              key={item.key}
              request={request}
              resolution={room.resolutions.get(item.requestId) ?? answeredResolution(member, request)}
              answering={room.answering.has(item.requestId)}
              note={notes.get(item.requestId) ?? ""}
              user={user}
              onNote={(value) => setNotes((current) => new Map(current).set(item.requestId, value))}
              onAnswer={(optionId) => void answer(item.requestId, optionId)}
              onOpenComputer={() => onOpenComputer(item.requestId)}
            />,
          );
          break;
        }
        case "steps":
          rows.push(
            <StepsBlock
              key={item.key}
              block={item}
              member={member}
              open={openSteps.has(item.key)}
              onToggle={() => toggleSteps(item.key)}
            />,
          );
          break;
      }
    }

    room.drafts.forEach((draft, index) => {
      rows.push(
        <div key={`draft:${index}`} className="msg bot">
          <Prose text={draft} />
        </div>,
      );
    });
    room.optimistic.forEach((message, index) => {
      rows.push(
        <div key={`sending:${index}`} className="msg you sending">
          {message}
        </div>,
      );
    });
    if (room.live && room.drafts.length === 0) {
      rows.push(
        <div key="working" className="working">
          <Avatar member={member} size={16} presence="thinking" />
          <span className="shine">{room.liveLabel ?? "Thinking"}</span>
        </div>,
      );
    }
    // Whoever is on work for this thread, as a running trace line: their live face, the job, and the step they are on.
    busy.forEach(({ bot, job }, index) => {
      const own = bot.id === member.id;
      rows.push(
        <Trace key={`busy:${bot.id}:${job.id}`} className="work-trace">
          <TraceLine status="running">
            <TraceIcon className="work-trace-face">
              <LiveAvatar member={bot} size={24} alive={index === 0} />
            </TraceIcon>
            <TraceTitle>{own ? `Working on ${job.title}` : `${bot.name} is working on ${job.title}`}</TraceTitle>
          </TraceLine>
          {bot.action === null ? null : (
            <TraceLine className="work-trace-step">
              <TraceTitle>{bot.action}</TraceTitle>
            </TraceLine>
          )}
        </Trace>,
      );
    });
    body = rows;
  }

  return (
    <div
      className="scroll"
      ref={scroller}
      onScroll={() => {
        const element = scroller.current;
        if (element !== null) {
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_PX;
        }
      }}
    >
      <div className={settled ? "transcript settled" : "transcript"} aria-live="polite">
        {body}
      </div>
    </div>
  );
}

/** One line of a job's journal, as the server keeps it (see `agent/lib/journal.ts`). */
interface JournalLine {
  readonly at: string;
  readonly runToken: string;
  readonly kind: "progress" | "decision" | "page" | "file" | "artifact" | "asked" | "handover" | "error";
  readonly text: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

const JOURNAL_WORDS: Readonly<Record<JournalLine["kind"], string>> = {
  progress: "Did",
  decision: "Decided",
  page: "Opened",
  file: "Wrote",
  artifact: "Saved",
  asked: "Asked",
  handover: "Back",
  error: "Failed",
};

/**
 * A job's journal, read when its steps are opened and again while the job
 * is still going. Null until read, or when the job has none (older jobs): the
 * feed's lines stand in.
 */
function useJournal(jobId: string | null, open: boolean, live: boolean): { lines: readonly JournalLine[]; resumedFrom: number; rewoundBy: string | null } | null {
  const [journal, setJournal] = useState<{ lines: readonly JournalLine[]; resumedFrom: number; rewoundBy: string | null } | null>(null);
  useEffect(() => {
    if (!open || jobId === null) return;
    let stopped = false;
    const read = async () => {
      try {
        const response = await api(`/bot/v1/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) return;
        const body = (await response.json()) as { job?: { journal?: JournalLine[]; resumedFrom?: number; rewound?: { by: string; index: number } } };
        const lines = body.job?.journal ?? [];
        const rewound = body.job?.rewound;
        const resumedFrom = body.job?.resumedFrom ?? 0;
        if (!stopped) setJournal(lines.length === 0 ? null : { lines, resumedFrom, rewoundBy: rewound !== undefined && rewound.index === resumedFrom ? rewound.by : null });
      } catch {
        // The feed's lines stay.
      }
    };
    void read();
    const timer = live ? setInterval(read, 5_000) : undefined;
    return () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [jobId, open, live]);
  return journal;
}

/** A page line links to the page; the rest are text. The label already says the verb, so a line that repeats it drops it. */

/** How long a stretch of work took, in a few characters: "48s", "3m 05s", "1h 12m". */
function took(fromIso: string, toIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const JOURNAL_ICONS: Readonly<Record<JournalLine["kind"], LucideIcon>> = {
  progress: CheckIcon,
  decision: GitBranchIcon,
  page: GlobeIcon,
  file: FilePenIcon,
  artifact: PaperclipIcon,
  asked: MessageCircleQuestionIcon,
  handover: HandIcon,
  error: TriangleAlertIcon,
};

/** A step's words, opening to the whole of them when they run past a line. */
function StepLine({
  icon: StepIcon,
  text,
  at,
  status,
  href,
}: {
  icon: LucideIcon;
  text: string;
  at: string;
  status?: "error";
  href?: string | null;
}) {
  const line = (
    <TraceLine {...(status === undefined ? {} : { status })}>
      <TraceIcon>
        <StepIcon />
      </TraceIcon>
      <TraceTitle>{text}</TraceTitle>
      <TraceDescription>{clock(new Date(at))}</TraceDescription>
    </TraceLine>
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {line}
      </a>
    );
  }
  if (text.length <= 90) return <div>{line}</div>;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * The steps a Bot logged for one job, as an AI Elements trace: one line with
 * the Bot's face, the job, how many steps and how long, shimmering while it
 * runs; open it for each step, and a long step opens to its whole text.
 */
function StepsBlock({
  block,
  member,
  open,
  onToggle,
}: {
  block: StepsItem;
  member: Member;
  open: boolean;
  onToggle: () => void;
}) {
  const latest = block.events[block.events.length - 1];
  const first = block.events[0];
  const title =
    block.events.map((event) => /"([^"]+)"/.exec(event.text)?.[1]).find((value) => value !== undefined) ?? "Work";
  const closed = latest !== undefined && ["job.done", "job.failed", "job.cancelled"].includes(latest.kind);
  const failed = latest?.kind === "job.failed";
  const journal = useJournal(block.jobId, open, !closed);
  if (latest === undefined || first === undefined) return null;
  const count = journal?.lines.length ?? block.events.length;
  const span = took(first.at, closed ? latest.at : new Date().toISOString());

  return (
    <Trace className="job-trace">
      <TraceCollapsible open={open} onOpenChange={onToggle}>
        <TraceCollapsibleTrigger>
          <TraceLine {...(closed ? (failed ? { status: "error" as const } : {}) : { status: "running" as const })}>
            <TraceIcon>
              <Avatar member={member} size={16} presence={latest.kind === "job.done" ? "done" : member.presence} />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            <TraceDescription>
              {count} {count === 1 ? "step" : "steps"} · {closed ? (failed ? `failed after ${span}` : `took ${span}`) : `${span} so far`}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {journal !== null
              ? journal.lines.map((line, index) => (
                  <JournalRow
                    key={`${line.at}:${index}`}
                    line={line}
                    resumedHere={journal.resumedFrom > 0 && index === journal.resumedFrom ? (journal.rewoundBy === null ? "Continued from here after a restart" : `Rewound to here by ${journal.rewoundBy}`) : null}
                    undoes={journal.lines.length - (index + 1)}
                    onRewind={block.jobId === null ? null : () => rewindTo(block.jobId as string, index + 1)}
                  />
                ))
              : block.events
                  .filter((event) => !["job.done", "job.failed", "job.cancelled"].includes(event.kind))
                  .map((event) => (
                    <StepLine key={event.id} icon={CheckIcon} text={event.kind === "job.progress" ? event.text : `${STEP_WORDS[event.kind] ?? "Did"}: ${event.text}`} at={event.at} />
                  ))}
            {closed ? (
              <StepLine
                icon={failed ? CircleXIcon : CircleCheckIcon}
                text={latest.text}
                at={latest.at}
                {...(failed ? { status: "error" as const } : {})}
              />
            ) : null}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

/** Takes a job back to just after step `index` (1-based count of steps kept). */
async function rewindTo(jobId: string, index: number): Promise<string> {
  const response = await api(`/bot/v1/jobs/${encodeURIComponent(jobId)}/rewind`, { method: "POST", body: JSON.stringify({ index }) });
  const body = (await response.json().catch(() => null)) as { error?: string; files?: { restoredFrom?: number; skipped?: string } } | null;
  if (!response.ok) return body?.error ?? "Could not rewind.";
  return body?.files?.restoredFrom !== undefined ? "Rewound; files restored, starting again." : `Rewound; files not restored (${body?.files?.skipped ?? "unknown"}).`;
}

function JournalRow({
  line,
  resumedHere,
  undoes,
  onRewind,
}: {
  line: JournalLine;
  /** The divider above this line, where a later run picked the job up. */
  resumedHere: string | null;
  /** How many later steps a rewind to here would undo. */
  undoes: number;
  onRewind: (() => Promise<string>) | null;
}) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const word = JOURNAL_WORDS[line.kind];
  const url = line.kind === "page" && typeof line.data?.url === "string" && /^https?:\/\//.test(line.data.url) ? line.data.url : null;
  const said = line.text.startsWith(`${word} `) ? line.text.slice(word.length + 1) : line.text;
  // A page whose title came back as raw data reads as its address instead.
  const text = url !== null && /^\s*[[{]/.test(said) ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : said;
  // Progress lines already say what was done ("Opened the page…"); the other kinds take their verb.
  const shown = line.kind === "progress" ? text : `${word} ${text}`;
  return (
    <>
      {resumedHere !== null ? (
        <TraceLine role="separator">
          <TraceIcon>
            <HistoryIcon />
          </TraceIcon>
          <TraceTitle>{resumedHere}</TraceTitle>
        </TraceLine>
      ) : null}
      <div className="trace-step">
        <StepLine
          icon={JOURNAL_ICONS[line.kind] ?? CheckIcon}
          text={shown}
          at={line.at}
          {...(line.kind === "error" ? { status: "error" as const } : {})}
          href={url}
        />
        {onRewind !== null && undoes > 0 && !asking ? (
          <Button variant="ghost" size="xs" className="trace-rewind" onClick={() => setAsking(true)} title="Take the job back to just after this step">
            <RotateCcwIcon data-icon="inline-start" />
            Rewind to here
          </Button>
        ) : null}
      </div>
      {asking && onRewind !== null ? (
        <div className="rewind-ask" data-slot="rewind-ask">
          <span>
            Undo the {undoes} later {undoes === 1 ? "step" : "steps"}, put this job&apos;s files back as they were, and run it again from here? Emails already sent stay sent.
          </span>
          <Button
            variant="destructive"
            size="xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(await onRewind());
              setBusy(false);
              setAsking(false);
            }}
          >
            {busy ? "Rewinding…" : "Rewind"}
          </Button>
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => setAsking(false)}>
            Keep
          </Button>
        </div>
      ) : null}
      {note === null ? null : (
        <TraceLine>
          <TraceIcon>
            <HistoryIcon />
          </TraceIcon>
          <TraceTitle>{note}</TraceTitle>
        </TraceLine>
      )}
    </>
  );
}

function EmptyChat({
  member,
  showMore,
  onMore,
  onSuggest,
}: {
  member: Member;
  showMore: boolean;
  onMore: () => void;
  onSuggest: (text: string) => void;
}) {
  const all = suggestionsFor(member);
  const shown = showMore ? all : all.slice(0, 4);
  return (
    <div className="empty-chat">
      <div className="empty-who">
        <Avatar member={member} size={40} />
        <div>
          <h2>{member.name}</h2>
          <p>{member.title}</p>
        </div>
      </div>
      <div className="suggest">
        <div className="suggest-title">
          <Icon name="folder" size={15} />
          {member.kind === "hq" ? "Get the team going" : `Ask ${member.name}`}
        </div>
        {shown.map((text) => (
          <button key={text} type="button" onClick={() => onSuggest(text)}>
            {text}
          </button>
        ))}
        {all.length > shown.length ? (
          <button type="button" className="more" onClick={onMore}>
            Show more
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Keeps one message as a memory about the person, by hand. Long messages are
 * kept whole up to the store's limit; the Memory page is where to trim them.
 */
function RememberButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  if (text.trim() === "") return null;
  return (
    <button
      type="button"
      className="icon-btn msg-remember"
      data-done={state === "done" ? "" : undefined}
      aria-label={state === "done" ? "Remembered" : "Remember this"}
      title={state === "done" ? "Remembered" : state === "failed" ? "Could not remember that" : "Remember this"}
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        try {
          const response = await api("/bot/v1/memory/profile", { method: "POST", body: JSON.stringify({ text: text.slice(0, 500) }) });
          setState(response.ok || response.status === 409 ? "done" : "failed");
        } catch {
          setState("failed");
        }
      }}
    >
      <Icon name={state === "done" ? "check" : "brain"} size={13} />
    </button>
  );
}
