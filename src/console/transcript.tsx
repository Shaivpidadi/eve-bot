"use client";

import type { InputRequest, InputResolution } from "eve/client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AskCard } from "./ask-card";
import { Avatar } from "./avatar";
import { clock, dividerWhen, needsDivider } from "./format";
import { Icon } from "./icons";
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
  /** Bots working in the background on this thread's behalf; see `busyIn` in chat.tsx. */
  busy: readonly Member[];
  user: string;
  store: RoomStore;
  onOpenComputer: (requestId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set());
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [showMore, setShowMore] = useState(false);

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
            <div key={item.key} className="msg you">
              {item.text}
            </div>,
          );
          break;
        case "bot":
          rows.push(
            <div key={item.key} className="msg bot">
              <Prose text={item.text} />
            </div>,
          );
          break;
        case "notice":
          rows.push(
            <div key={item.key} className={item.tone === "error" ? "notice error" : "notice"}>
              <Icon name={item.icon} size={13} />
              <span>{item.label}</span>
              {item.detail ? <b>{item.detail}</b> : null}
              {item.action === "start-over" ? (
                <button type="button" className="btn" onClick={() => void store.startOver()}>
                  Start over
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
    // The Bots on jobs for this thread, animated until their work comes back.
    for (const bot of busy) {
      rows.push(
        <div key={`busy:${bot.id}`} className="working">
          <Avatar member={bot} size={16} presence="thinking" />
          <span className="shimmer">
            {bot.id === member.id ? "Working" : `${bot.name} is working`}
            {bot.action === null ? "" : ` · ${bot.action}`}
          </span>
        </div>,
      );
    }
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
      <div className="transcript" aria-live="polite">
        {body}
      </div>
    </div>
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
  const count = block.events.length;

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
      {open ? (
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
