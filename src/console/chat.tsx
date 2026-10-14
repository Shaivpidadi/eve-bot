"use client";

import { type CSSProperties, useMemo, useSyncExternalStore } from "react";

import { Avatar, memberColor } from "./avatar";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { TeamContext } from "./mentions";
import { buildTimeline, roomStore } from "./room-store";
import { Transcript } from "./transcript";
import type { ActivityEvent, Hover, Member } from "./types";
import type { WorkInHand } from "../../agent/lib/board";

/**
 * Bots at work whose progress belongs in this thread: from HQ's desk, every
 * Bot on a job; in a Bot's own thread, that Bot, unless its live turn is
 * already showing. Work runs in the background after HQ's turn ends, so this
 * is what keeps the thread from looking asleep until the result comes back.
 */
/** A teammate at work for this thread: whoever took a job asked here, and this Bot on work asked elsewhere. */
export interface Busy {
  readonly bot: Member;
  readonly job: WorkInHand;
}

function busyIn(member: Member, members: readonly Member[], live: boolean): Busy[] {
  const out: Busy[] = [];
  for (const candidate of members) {
    for (const job of candidate.jobs) {
      if (job.status !== "running" && job.status !== "dispatched") continue;
      const askedHere = job.room === member.room;
      const mineFromElsewhere = candidate.id === member.id && !askedHere;
      if (!askedHere && !mineFromElsewhere) continue;
      // The thread's own turn already shows that it is thinking.
      if (candidate.id === member.id && live && askedHere) continue;
      out.push({ bot: candidate, job });
    }
  }
  return out;
}

export function ChatPane({
  member,
  members,
  activity,
  user,
  onBack,
  onToggleComputer,
  onOpenComputer,
  onHover,
}: {
  member: Member;
  members: readonly Member[];
  activity: readonly ActivityEvent[];
  user: string;
  onBack: () => void;
  onToggleComputer: () => void;
  /** Opens the computer to answer a Bot's request to take over its browser. */
  onOpenComputer: (requestId: string) => void;
  onHover: (hover: Hover | null) => void;
}) {
  const store = roomStore(member.room);
  const room = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const timeline = useMemo(() => buildTimeline(member, room.items, activity, members), [member, room.items, activity, members]);
  const busy = useMemo(() => busyIn(member, members, room.live), [member, members, room.live]);

  return (
    <TeamContext.Provider value={members}>
      <main className="chat" style={{ "--you": memberColor(member) } as CSSProperties}>
        <header className="chat-head">
          <button type="button" className="icon-btn back" aria-label="Back to Bots" onClick={onBack}>
            <Icon name="left" />
          </button>
          <span className="head-chip">
            <Avatar member={member} size={22} onHover={onHover} />
            <span className="head-name">{member.name}</span>
          </span>
          <button
            type="button"
            className={member.computer.active ? "icon-btn computer-btn active" : "icon-btn computer-btn"}
            aria-label="Team computer"
            title={member.computer.active ? "The team's computer is in use" : "Team computer"}
            onClick={onToggleComputer}
          >
            <Icon name="monitor" />
          </button>
        </header>
        <Transcript
          member={member}
          room={room}
          timeline={timeline}
          busy={busy}
          user={user}
          store={store}
          onOpenComputer={onOpenComputer}
        />
        <Composer member={member} live={room.live} store={store} />
      </main>
    </TeamContext.Provider>
  );
}
