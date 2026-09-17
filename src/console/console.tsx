"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

import { Avatar } from "./avatar";
import { ChatPane } from "./chat";
import { ComputerView } from "./computer/computer-view";
import { PRESENCE_LABEL } from "./format";
import { HireDialog } from "./hire-dialog";
import { Icon } from "./icons";
import { MemoryDialog } from "./memory-dialog";
import { DetailsPanel, type PanelView } from "./panel";
import { PANEL_SLIDE_MS, PanelResizer, usePanelWidth } from "./panel-frame";
import { PluginsDialog } from "./plugins-dialog";
import { Sidebar } from "./sidebar";
import type { Hover, Member } from "./types";
import { useBoard } from "./use-board";

const HQ_ID = "hq";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing: the choice is simply not remembered.
  }
}

/**
 * Whose thread the team's computer opens from. The screen is the same for
 * everyone; in a Bot's own thread it is that Bot's, and from HQ's desk it is the
 * Bot at work that is waiting on you, or HQ's own view when nobody is.
 */
function computerFor(member: Member, members: readonly Member[]): Member {
  if (member.kind === "bot") return member;
  const bots = members.filter((entry) => entry.kind === "bot");
  return (
    bots.find((bot) => bot.computer.active && bot.presence === "waiting") ??
    bots.find((bot) => bot.computer.active) ??
    bots.find((bot) => bot.presence === "waiting") ??
    member
  );
}

/**
 * Bots on the left, the selected thread in the middle, and the team's computer
 * with that Bot's routines and files on the right.
 */
export function Console() {
  const { board, online, refresh } = useBoard();
  const [selectedId, setSelectedId] = useState(() => read("bot.selected") ?? HQ_ID);
  const [panelOpen, setPanelOpen] = useState(
    () => (read("bot.panel") ?? (window.innerWidth > 1080 ? "open" : "closed")) === "open",
  );
  const [panelView, setPanelView] = useState<PanelView>("overview");
  const [view, setView] = useState<"roster" | "chat">(() => (window.innerWidth > 760 ? "chat" : "roster"));
  const [computer, setComputer] = useState<{ botId: string; requestId: string | null } | null>(null);
  const [hiring, setHiring] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [resizing, setResizing] = useState(false);
  // The panel slides closed, so what it shows stays until the slide has finished.
  const [panelMounted, setPanelMounted] = useState(panelOpen);
  // Rooms marked unread from the roster menu, kept in this browser only.
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => {
    try {
      const saved: unknown = JSON.parse(read("bot.unread") ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const markUnread = useCallback((id: string, flag: boolean) => {
    setUnread((current) => {
      if (current.has(id) === flag) return current;
      const next = new Set(current);
      if (flag) next.add(id);
      else next.delete(id);
      write("bot.unread", JSON.stringify([...next]));
      return next;
    });
  }, []);
  // Bumped when the roster menu asks to edit a profile; the panel opens its form.
  const [editRequest, setEditRequest] = useState(0);
  // Opening a room reads it.
  useEffect(() => {
    if (selectedId !== null) markUnread(selectedId, false);
  }, [selectedId, markUnread]);

  const members = board?.members ?? [];
  const member = members.find((entry) => entry.id === selectedId) ?? members.find((entry) => entry.id === HQ_ID);
  const computerMember = computer === null ? undefined : members.find((entry) => entry.id === computer.botId);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    write("bot.selected", id);
    setPanelView("overview");
    setComputer(null);
    setHover(null);
    setView("chat");
  }, []);

  const showPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    write("bot.panel", open ? "open" : "closed");
  }, []);

  const closeComputer = useCallback(() => setComputer(null), []);

  const pending = members.reduce((count, entry) => count + entry.pending, 0);
  const needed = members.filter((entry) => entry.kind === "bot" && entry.computer.handover !== null);
  // Banners a person closed, by the request they were for: a later handover shows again.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const banners = needed.filter((entry) => !dismissed.has(entry.computer.handover?.requestId ?? ""));
  const dismiss = useCallback((requestId: string) => {
    setDismissed((current) => new Set(current).add(requestId));
  }, []);
  useEffect(() => {
    const first = needed[0];
    document.title =
      first !== undefined
        ? `(${needed.length}) ${first.name} needs you`
        : pending > 0
          ? `(${pending}) Bot`
          : "Bot";
  }, [pending, needed]);

  useEffect(() => {
    if (panelOpen) {
      setPanelMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setPanelMounted(false), PANEL_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [panelOpen]);

  if (board === null || member === undefined) return <div className="app-loading" aria-busy="true" />;

  return (
    <>
      <div
        className="app"
        data-panel={panelOpen ? "open" : "closed"}
        data-view={view}
        data-resizing={resizing ? "" : undefined}
        style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
      >
        <Sidebar
          members={members}
          selectedId={member.id}
          user={board.user}
          workspaceId={board.workspaceId}
          onSelect={select}
          onHire={() => setHiring(true)}
          onPlugins={() => setPluginsOpen(true)}
          onMemory={() => setMemoryOpen(true)}
          onHover={setHover}
          unread={unread}
          onUnread={markUnread}
          onChanged={refresh}
          onEditProfile={(id) => {
            select(id);
            showPanel(true);
            setPanelView("settings");
            setEditRequest((count) => count + 1);
          }}
        />
        <ChatPane
          key={member.room}
          member={member}
          activity={board.activity}
          user={board.user}
          onBack={() => setView("roster")}
          onToggleComputer={() => {
            // Status → preview: the icon opens the pinned panel, or closes it.
            showPanel(!(panelOpen && panelView === "overview"));
            setPanelView("overview");
          }}
          onOpenComputer={(requestId) => setComputer({ botId: computerFor(member, members).id, requestId })}
          onHover={setHover}
        />
        <div className="panel-slot" inert={!panelOpen}>
          {panelOpen || panelMounted ? (
            <>
              <PanelResizer width={panelWidth} onWidth={setPanelWidth} onResizing={setResizing} />
              <DetailsPanel
                member={member}
                members={members}
                view={panelView}
                onView={setPanelView}
                onClose={() => showPanel(false)}
                onSelect={(id) => {
                  select(id);
                  if (window.innerWidth <= 1080) showPanel(false);
                }}
                onTakeover={() => setComputer({ botId: computerFor(member, members).id, requestId: null })}
                onChanged={refresh}
                onHover={setHover}
                editRequest={editRequest}
              />
            </>
          ) : null}
        </div>
      </div>

      {banners.length > 0 && computer === null ? (
        <div className="needs-you" role="status">
          {banners.slice(0, 3).map((bot) => (
            <div key={bot.id} className="needs-you-row">
              <Avatar member={bot} size={20} />
              <span className="needs-you-text">
                <b>{`${bot.name} needs you`}</b>
                {bot.computer.handover === null ? null : <span className="faint">{bot.computer.handover.reason}</span>}
              </span>
              <button
                type="button"
                className="btn primary"
                onClick={() => setComputer({ botId: bot.id, requestId: null })}
              >
                Open computer
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Dismiss"
                title="Dismiss. The Bot keeps waiting; open its computer from the roster."
                onClick={() => {
                  if (bot.computer.handover !== null) dismiss(bot.computer.handover.requestId);
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {computer !== null && computerMember !== undefined ? (
        <ComputerView
          member={computerMember}
          user={board.user}
          requestId={computer.requestId}
          onClose={closeComputer}
        />
      ) : null}

      <PluginsDialog open={pluginsOpen} onClose={() => setPluginsOpen(false)} />
      <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} />

      <HireDialog
        open={hiring}
        onClose={() => setHiring(false)}
        onHired={async (id) => {
          await refresh();
          select(id);
        }}
      />

      {hover === null ? null : <HoverCard hover={hover} />}
      {online ? null : <div className="offline">Reconnecting…</div>}
    </>
  );
}

/** Hover a Bot's face to see what it is doing, without opening anything. */
function HoverCard({ hover }: { hover: Hover }) {
  const { member, rect } = hover;
  return (
    <div
      className="hovercard"
      style={{ left: Math.min(rect.right + 8, window.innerWidth - 268), top: Math.max(8, rect.top - 4) }}
    >
      <b>
        {member.name} · {member.status === "paused" ? "Paused" : PRESENCE_LABEL[member.presence]}
      </b>
      <span>{member.action ?? member.title}</span>
    </div>
  );
}
