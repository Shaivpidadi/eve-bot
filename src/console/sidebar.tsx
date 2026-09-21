"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { api, errorMessage, SignedOutError } from "./api";
import { Avatar } from "./avatar";
import { shortWhen, withoutEmoji } from "./format";
import { Icon, type IconName } from "./icons";
import { PromptDialog, type Prompt } from "./prompt-dialog";
import { roomStore } from "./room-store";
import { useTheme } from "./theme";
import type { Hover, Member, Profile } from "./types";

/** Where a row's menu is anchored, and for whom. */
interface Menu {
  readonly member: Member;
  readonly x: number;
  readonly y: number;
}

/** The roster: HQ, then pinned Bots, then each section, then the rest; hidden ones folded away. */
function grouped(rows: readonly Member[]) {
  const hq = rows.find((member) => member.kind === "hq") ?? null;
  const bots = rows.filter((member) => member.kind === "bot");
  const shown = bots.filter((member) => !member.hidden);
  const hidden = bots.filter((member) => member.hidden);
  const pinned = shown.filter((member) => member.pinned);
  const sections = new Map<string, Member[]>();
  const rest: Member[] = [];
  for (const member of shown) {
    if (member.pinned) continue;
    if (member.section === null) rest.push(member);
    else sections.set(member.section, [...(sections.get(member.section) ?? []), member]);
  }
  const named = [...sections.entries()].sort(([left], [right]) => left.localeCompare(right));
  return { hq, pinned, sections: named, rest, hidden, grouping: pinned.length > 0 || named.length > 0 };
}

export function Sidebar({
  members,
  selectedId,
  user,
  profile,
  workspaceId,
  unread,
  onSelect,
  onHire,
  onConnectors,
  onMemory,
  onUsage,
  onHover,
  onUnread,
  onChanged,
  onEditProfile,
}: {
  members: readonly Member[];
  selectedId: string;
  user: string;
  profile: Profile | null;
  workspaceId: string;
  /** Rooms the person marked unread, or that have not been opened since a mark. */
  unread: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onHire: () => void;
  onConnectors: () => void;
  onMemory: () => void;
  onUsage: () => void;
  onHover: (hover: Hover | null) => void;
  onUnread: (id: string, unread: boolean) => void;
  /** The roster changed on the server; re-read it. */
  onChanged: () => Promise<void>;
  /** Open this Bot's profile for editing in the details panel. */
  onEditProfile: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [theme, toggleTheme] = useTheme();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const rows = members.filter(
    (member) =>
      needle === "" ||
      member.name.toLowerCase().includes(needle) ||
      member.title.toLowerCase().includes(needle) ||
      (member.preview?.text ?? "").toLowerCase().includes(needle),
  );
  const groups = grouped(rows);
  const sectionNames = [...new Set(members.flatMap((member) => (member.section === null ? [] : [member.section])))].sort();

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openMenu = (member: Member, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // From a right-click the menu sits at the pointer; from the ⋯ button, under it.
    const fromPointer = event.type === "contextmenu";
    setMenu({ member, x: fromPointer ? event.clientX : rect.right, y: fromPointer ? event.clientY : rect.bottom + 4 });
  };

  /** One change to a Bot's record; the roster re-reads after. */
  const patch = async (member: Member, body: Record<string, unknown>, failing: string): Promise<string | null> => {
    try {
      const response = await api(`/bot/v1/bots/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!response.ok) return await errorMessage(response, failing);
      await onChanged();
      return null;
    } catch (caught) {
      return caught instanceof SignedOutError ? null : failing;
    }
  };

  const act = async (work: Promise<string | null>) => {
    const problem = await work;
    if (problem !== null) setNotice(problem);
  };

  const row = (member: Member) => {
    const preview = withoutEmoji(member.preview?.text ?? member.title);
    const needsYou = member.pending > 0 || member.presence === "waiting";
    const isUnread = unread.has(member.id) && member.id !== selectedId;
    const classes = ["row", needsYou ? "needs" : "", member.status === "paused" ? "paused" : "", isUnread ? "unread" : ""];
    return (
      <div key={member.id} className={`row-wrap${menu?.member.id === member.id ? " menu-open" : ""}`}>
        <button
          type="button"
          className={classes.filter(Boolean).join(" ")}
          aria-current={member.id === selectedId}
          onClick={() => onSelect(member.id)}
          onContextMenu={(event) => openMenu(member, event)}
        >
          <Avatar member={member} size={22} onHover={onHover} />
          <span className="row-main">
            <span className="row-top">
              <span className="row-name">
                {member.name}
                {member.pinned ? <Icon name="pin" size={11} className="row-pin" /> : null}
              </span>
              <time>{shortWhen(member.preview?.at)}</time>
            </span>
            <span className="row-preview">{member.status === "paused" ? `Paused · ${preview}` : preview}</span>
          </span>
        </button>
        <button
          type="button"
          className="icon-btn row-menu-btn"
          aria-label={`Options for ${member.name}`}
          aria-haspopup="menu"
          onClick={(event) => openMenu(member, event)}
        >
          <Icon name="more" size={14} />
        </button>
      </div>
    );
  };

  const head = (title: string) => <div className="roster-head">{title}</div>;

  return (
    <aside className="sidebar" aria-label="Your Bots">
      <div className="side-top">
        <button type="button" className="icon-btn" aria-label="New Bot" title="New Bot" onClick={onHire}>
          <Icon name="plus" />
        </button>
      </div>
      <label className="search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <nav className="roster">
        {rows.length === 0 ? (
          <p className="roster-empty">No Bots match.</p>
        ) : (
          <>
            {groups.hq === null ? null : row(groups.hq)}
            {groups.pinned.length > 0 ? head("Pinned") : null}
            {groups.pinned.map(row)}
            {groups.sections.map(([name, bots]) => (
              <div key={`section:${name}`} className="roster-section">
                {head(name)}
                {bots.map(row)}
              </div>
            ))}
            {groups.grouping && groups.rest.length > 0 ? head("Bots") : null}
            {groups.rest.map(row)}
            {groups.hidden.length > 0 ? (
              <>
                <button type="button" className="roster-toggle" onClick={() => setShowHidden((value) => !value)}>
                  <Icon name={showHidden ? "eyeoff" : "eyeoff"} size={12} />
                  {showHidden ? "Hide hidden Bots" : `Hidden (${groups.hidden.length})`}
                </button>
                {showHidden ? groups.hidden.map(row) : null}
              </>
            ) : null}
          </>
        )}
      </nav>

      {notice === null ? null : (
        <p className="side-note" role="status">
          {notice}
        </p>
      )}

      <div className="side-bottom">
        <button type="button" className="side-item" onClick={onConnectors}>
          <Icon name="plug" />
          Connectors
        </button>
        <button type="button" className="side-item" onClick={onMemory}>
          <Icon name="brain" />
          Memory
        </button>
        <button type="button" className="side-item" onClick={onUsage}>
          <Icon name="chart" size={15} />
          Usage
        </button>
        <div className="me">
          {profile?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="me-avatar me-photo" src={profile.avatarUrl} alt="" width={20} height={20} />
          ) : (
            <span className="me-avatar">{(profile?.name ?? user ?? "You").charAt(0).toUpperCase()}</span>
          )}
          <span className="me-name" title={profile?.source === "vercel" ? "Signed in with Vercel" : undefined}>
            {profile?.name ?? user ?? "You"} <span className="me-ws">{workspaceId}</span>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
            onClick={toggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <form method="post" action="/bot/v1/session/end">
            <button type="submit" className="icon-btn" aria-label="Sign out" title="Sign out">
              <Icon name="signout" />
            </button>
          </form>
        </div>
      </div>

      {menu === null ? null : (
        <RowMenu
          menu={menu}
          sections={sectionNames}
          isUnread={unread.has(menu.member.id)}
          onClose={() => setMenu(null)}
          onPin={(member) => void act(patch(member, { pinned: !member.pinned }, "Could not pin the Bot."))}
          onSection={(member, section) => void act(patch(member, { section }, "Could not move the Bot."))}
          onNewSection={(member) =>
            setPrompt({
              title: "New section",
              description: `${member.name} moves into it. Sections group Bots in the roster.`,
              label: "Section name",
              placeholder: "Sales",
              maxLength: 40,
              confirm: "Create",
              onConfirm: (value) => patch(member, { section: value }, "Could not create the section."),
            })
          }
          onUnread={(member) => onUnread(member.id, !unread.has(member.id))}
          onRename={(member) =>
            setPrompt({
              title: "Rename Bot",
              description: "Bots are addressed by name in every thread, so pick one the team will recognise.",
              label: "Name",
              defaultValue: member.name,
              maxLength: 40,
              confirm: "Rename",
              onConfirm: (value) => patch(member, { name: value }, "Could not rename the Bot."),
            })
          }
          onEditProfile={(member) => onEditProfile(member.id)}
          onDuplicate={(member) =>
            void act(
              (async () => {
                try {
                  const response = await api(`/bot/v1/bots/${encodeURIComponent(member.id)}/duplicate`, { method: "POST" });
                  if (!response.ok) return await errorMessage(response, "Could not duplicate the Bot.");
                  const created = (await response.json()) as { bot: { id: string } };
                  await onChanged();
                  onSelect(created.bot.id);
                  return null;
                } catch (caught) {
                  return caught instanceof SignedOutError ? null : "Could not duplicate the Bot.";
                }
              })(),
            )
          }
          onClearChat={(member) =>
            setPrompt({
              title: `Clear chat with ${member.name}?`,
              description:
                member.kind === "hq"
                  ? "HQ's desk starts over: the conversation is cleared and its open one-off jobs are cancelled. The roster, finished work, and memory stay."
                  : `${member.name}'s thread starts over: the conversation is cleared and its open one-off jobs are cancelled. ${member.name}, its finished work, and what it learned stay.`,
              confirm: "Clear chat",
              danger: true,
              onConfirm: async () => {
                try {
                  const response = await api(`/bot/v1/rooms/${encodeURIComponent(member.room)}/reset`, { method: "POST" });
                  if (!response.ok) return await errorMessage(response, "Could not clear the chat.");
                  // The open transcript, if it is this one, empties at once rather than on the next poll.
                  roomStore(member.room).restart();
                  onUnread(member.id, false);
                  await onChanged();
                  return null;
                } catch (caught) {
                  return caught instanceof SignedOutError ? null : "Could not clear the chat.";
                }
              },
            })
          }
          onCopyId={(member) =>
            void act(
              navigator.clipboard
                .writeText(member.room)
                .then(() => {
                  setNotice(`Copied ${member.room}`);
                  return null;
                })
                .catch(() => `Could not copy. The conversation id is ${member.room}.`),
            )
          }
          onHide={(member) => void act(patch(member, { hidden: !member.hidden }, "Could not hide the Bot."))}
          onDelete={(member) =>
            setPrompt({
              title: `Delete ${member.name}?`,
              description: `${member.name} leaves the team for good: its open jobs are cancelled and what it learned is discarded. Its thread stays readable. Pausing keeps everything if you might want it back.`,
              confirm: "Delete",
              danger: true,
              onConfirm: async () => {
                try {
                  const response = await api(`/bot/v1/bots/${encodeURIComponent(member.id)}`, { method: "DELETE" });
                  if (!response.ok) return await errorMessage(response, "Could not delete the Bot.");
                  await onChanged();
                  if (member.id === selectedId) onSelect("hq");
                  return null;
                } catch (caught) {
                  return caught instanceof SignedOutError ? null : "Could not delete the Bot.";
                }
              },
            })
          }
        />
      )}
      <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} />
    </aside>
  );
}

/** The row menu: what you can do to a Bot without opening its thread. */
function RowMenu({
  menu,
  sections,
  isUnread,
  onClose,
  onPin,
  onSection,
  onNewSection,
  onUnread,
  onRename,
  onEditProfile,
  onDuplicate,
  onCopyId,
  onClearChat,
  onHide,
  onDelete,
}: {
  menu: Menu;
  sections: readonly string[];
  isUnread: boolean;
  onClose: () => void;
  onPin: (member: Member) => void;
  onSection: (member: Member, section: string | null) => void;
  onNewSection: (member: Member) => void;
  onUnread: (member: Member) => void;
  onRename: (member: Member) => void;
  onEditProfile: (member: Member) => void;
  onDuplicate: (member: Member) => void;
  onCopyId: (member: Member) => void;
  onClearChat: (member: Member) => void;
  onHide: (member: Member) => void;
  onDelete: (member: Member) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const { member } = menu;
  const [showSections, setShowSections] = useState(false);

  // Anything outside the menu closes it, as does Escape or scrolling the roster.
  useEffect(() => {
    const away = (event: Event) => {
      if (element.current !== null && event.target instanceof Node && element.current.contains(event.target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    document.querySelector(".roster")?.addEventListener("scroll", onClose, { once: true });
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Keep the menu on screen; it is measured after the first paint.
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const box = element.current?.getBoundingClientRect();
    if (box === undefined) return;
    setPlaced({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8)),
    });
  }, [menu.x, menu.y, showSections]);

  const item = (icon: IconName, label: string, run: () => void, extra?: { danger?: boolean; disabled?: boolean }) => (
    <button
      type="button"
      role="menuitem"
      className={extra?.danger ? "danger" : undefined}
      disabled={extra?.disabled}
      onClick={() => {
        onClose();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );

  const bot = member.kind === "bot";
  const others = sections.filter((name) => name !== member.section);

  return (
    <div
      ref={element}
      className="menu"
      role="menu"
      aria-label={`${member.name} options`}
      style={{ left: placed?.left ?? menu.x, top: placed?.top ?? menu.y, visibility: placed === null ? "hidden" : "visible" }}
    >
      {bot ? item("pin", member.pinned ? "Unpin" : "Pin", () => onPin(member)) : null}
      {bot ? (
        showSections ? (
          <>
            <div className="menu-head">Move to</div>
            {others.map((name) => (
              <button key={name} type="button" role="menuitem" onClick={() => { onClose(); onSection(member, name); }}>
                <Icon name="folder" size={14} />
                {name}
              </button>
            ))}
            {item("plus", "New section…", () => onNewSection(member))}
            {member.section === null ? null : item("x", `Remove from ${member.section}`, () => onSection(member, null))}
          </>
        ) : (
          <button type="button" role="menuitem" aria-haspopup="menu" onClick={() => setShowSections(true)}>
            <Icon name="folder" size={14} />
            {others.length > 0 || member.section !== null ? "Move to section…" : "Move to new section…"}
          </button>
        )
      ) : null}
      {item("mail", isUnread ? "Mark as read" : "Mark as unread", () => onUnread(member))}
      {item("eraser", "Clear chat", () => onClearChat(member))}
      {bot ? <hr /> : null}
      {bot ? item("edit", "Rename Bot", () => onRename(member)) : null}
      {bot ? item("person", "Edit profile", () => onEditProfile(member)) : null}
      {bot ? item("copy", "Duplicate", () => onDuplicate(member)) : null}
      <hr />
      {item("copy", "Copy conversation ID", () => onCopyId(member))}
      {bot ? <hr /> : null}
      {bot ? item("eyeoff", member.hidden ? "Show in sidebar" : "Hide from sidebar", () => onHide(member)) : null}
      {bot ? item("trash", "Delete", () => onDelete(member), { danger: true }) : null}
    </div>
  );
}
