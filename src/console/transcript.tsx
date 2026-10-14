"use client";

import type { InputRequest, InputResolution } from "eve/client";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

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
          <span className="shimmer">{room.liveLabel ?? "Thinking"}</span>
        </div>,
      );
    }
    // Whoever is on work for this thread: their live face, the job, and the step they are on.
    busy.forEach(({ bot, job }, index) => {
      const own = bot.id === member.id;
      rows.push(
        <div key={`busy:${bot.id}:${job.id}`} className="work-row">
          <LiveAvatar member={bot} size={28} alive={index === 0} />
          <span className="work-row-text">
            <span className="work-row-head">
              {own ? "Working on" : <b>{bot.name}</b>}
              {own ? " " : " is working on "}
              <span className="work-row-title">{job.title}</span>
            </span>
            {bot.action === null ? null : <span className="work-row-step shimmer">{bot.action}</span>}
          </span>
        </div>,
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
function JournalText({ line }: { line: JournalLine }) {
  const word = JOURNAL_WORDS[line.kind];
  const text = line.text.startsWith(`${word} `) ? line.text.slice(word.length + 1) : line.text;
  const url = line.kind === "page" && typeof line.data?.url === "string" ? line.data.url : null;
  if (url === null || !/^https?:\/\//.test(url)) return <span>{text}</span>;
  return (
    <span>
      <a href={url} target="_blank" rel="noreferrer noopener">
        {text}
      </a>
    </span>
  );
}

/** The steps a Bot logged for one job, folded into a line that opens. */
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
  if (latest === undefined) return null;
  const title =
    block.events.map((event) => /"([^"]+)"/.exec(event.text)?.[1]).find((value) => value !== undefined) ?? "Work";
  const live = !["job.done", "job.failed", "job.cancelled"].includes(latest.kind);
  const journal = useJournal(block.jobId, open, live);
  const count = journal?.lines.length ?? block.events.length;

  return (
    <div className={open ? "steps open" : "steps"}>
      <button type="button" className="steps-head" aria-expanded={open} onClick={onToggle}>
        <Avatar member={member} size={16} presence={latest.kind === "job.done" ? "done" : member.presence} />
        <span className="title">{title}</span>
        <span className="latest">
          · {count} {count === 1 ? "step" : "steps"} · {latest.text}
        </span>
        <Icon name="chev" size={14} className="chev" />
      </button>
      {open && journal !== null ? (
        <ol className="steps-list">
          {journal.lines.map((line, index) => (
            <JournalRow
              key={`${line.at}:${index}`}
              line={line}
              resumedHere={journal.resumedFrom > 0 && index === journal.resumedFrom ? (journal.rewoundBy === null ? "Continued from here after a restart" : `Rewound to here by ${journal.rewoundBy}`) : null}
              undoes={journal.lines.length - (index + 1)}
              onRewind={block.jobId === null ? null : () => rewindTo(block.jobId as string, index + 1)}
            />
          ))}
          {latest.kind === "job.done" || latest.kind === "job.failed" || latest.kind === "job.cancelled" ? (
            <li className={latest.kind === "job.failed" ? "bad" : latest.kind === "job.done" ? "good" : undefined}>
              <span className="k">{STEP_WORDS[latest.kind] ?? "Did"}</span>
              <span>{latest.text}</span>
              <time>{clock(new Date(latest.at))}</time>
            </li>
          ) : null}
        </ol>
      ) : open ? (
        <ol className="steps-list">
          {block.events.map((event) => (
            <li
              key={event.id}
              className={event.kind === "job.failed" ? "bad" : event.kind === "job.done" ? "good" : undefined}
            >
              <span className="k">{STEP_WORDS[event.kind] ?? "Did"}</span>
              <span>{event.text}</span>
              <time>{clock(new Date(event.at))}</time>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
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
  return (
    <>
      {resumedHere !== null ? (
        <li className="resumed" role="separator">
          <span>{resumedHere}</span>
        </li>
      ) : null}
      <li className={line.kind === "error" ? "bad" : line.kind === "decision" ? "decision" : undefined}>
        <span className="k">{JOURNAL_WORDS[line.kind] ?? "Did"}</span>
        <JournalText line={line} />
        {onRewind !== null && undoes > 0 && !asking ? (
          <button type="button" className="rewind" onClick={() => setAsking(true)} title="Take the job back to just after this step">
            Rewind to here
          </button>
        ) : null}
        <time>{clock(new Date(line.at))}</time>
      </li>
      {asking && onRewind !== null ? (
        <li className="rewind-ask">
          <span>
            Undo the {undoes} later {undoes === 1 ? "step" : "steps"}, put this job&apos;s files back as they were, and run it again from here? Emails already sent stay sent.
          </span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(await onRewind());
              setBusy(false);
              setAsking(false);
            }}
          >
            {busy ? "Rewinding…" : "Rewind"}
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>
            Keep
          </button>
        </li>
      ) : null}
      {note === null ? null : (
        <li className="resumed">
          <span>{note}</span>
        </li>
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
