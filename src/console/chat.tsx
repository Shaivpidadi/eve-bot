"use client";

import { useMemo, useSyncExternalStore } from "react";

import { Avatar } from "./avatar";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { buildTimeline, roomStore } from "./room-store";
import { Transcript } from "./transcript";
import type { ActivityEvent, Hover, Member } from "./types";

export function ChatPane({
  member,
  activity,
  user,
  onBack,
  onToggleComputer,
  onOpenComputer,
  onHover,
}: {
  member: Member;
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
  const timeline = useMemo(() => buildTimeline(member, room.items, activity), [member, room.items, activity]);

  return (
    <main className="chat">
      <header className="chat-head">
        <button type="button" className="icon-btn back" aria-label="Back to Bots" onClick={onBack}>
          <Icon name="left" />
        </button>
        <Avatar member={member} size={18} onHover={onHover} />
        <span className="head-name">{member.name}</span>
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
        user={user}
        store={store}
        onOpenComputer={onOpenComputer}
      />
      <Composer member={member} live={room.live} store={store} />
    </main>
  );
}
