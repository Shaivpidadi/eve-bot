"use client";

import { BrandMark } from "./brands";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { api, errorMessage, SignedOutError } from "./api";
import { Avatar } from "./avatar";
import { shortWhen, withoutEmoji } from "./format";
import { Icon, type IconName } from "./icons";
import { PromptDialog, type Prompt } from "./prompt-dialog";
import { roomStore } from "./room-store";
import { useTheme } from "./theme";
import type { Board, Hover, Member, Profile } from "./types";

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

interface AppIcon {
  readonly key: string;
  readonly brand: string | null;
  readonly label: string;
  readonly url: string | null;
}

/** The apps the team has connected, for the footer's pill; a few from the catalog until there are any. */
function useConnectedApps(): { connected: boolean; list: readonly AppIcon[] } {
  const [state, setState] = useState<{ connected: boolean; list: readonly AppIcon[] }>({
    connected: false,
    list: ["github", "linear", "notion"].map((brand) => ({ key: brand, brand, label: brand, url: null })),
  });
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      try {
        const response = await api("/bot/v1/connectors");
        if (!response.ok) return;
        const body = (await response.json()) as { connectors?: { id: string; label: string; catalog: string | null; url: string; enabled: boolean }[] };
        const on = (body.connectors ?? []).filter((connector) => connector.enabled);
        if (!stopped && on.length > 0) {
          setState({ connected: true, list: on.map((connector) => ({ key: connector.id, brand: connector.catalog, label: connector.label, url: connector.catalog === null ? connector.url : null })) });
        }
      } catch {
        // The pill keeps what it showed.
      }
    };
    void read();
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return state;
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
  health,
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
  /** Overdue work and dead runs; absent from a server that does not report them. */
  health?: Board["health"];
}) {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [theme, toggleTheme] = useTheme();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [meOpen, setMeOpen] = useState(false);
  const apps = useConnectedApps();

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
          <Avatar member={member} size={32} onHover={onHover} />
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

  /** HQ and pinned Bots, as tiles above the list: the ones used most, a click away. */
  const tile = (member: Member) => {
    const needsYou = member.pending > 0 || member.presence === "waiting";
    const isUnread = unread.has(member.id) && member.id !== selectedId;
    return (
      <button
        key={member.id}
        type="button"
        className={`tile${member.status === "paused" ? " paused" : ""}`}
        aria-current={member.id === selectedId}
        title={member.title}
        onClick={() => onSelect(member.id)}
        onContextMenu={member.kind === "bot" ? (event) => openMenu(member, event) : undefined}
      >
        <Avatar member={member} size={40} onHover={onHover} />
        <span className="tile-name">{member.name}</span>
        {needsYou ? <span className="tile-badge needs" aria-label="Needs you" /> : isUnread ? <span className="tile-badge" aria-label="Unread" /> : null}
      </button>
    );
  };

  return (
    <aside className="sidebar" aria-label="Your Bots">
      <div className="side-top">
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
        <button type="button" className="icon-btn round" aria-label="New Bot" title="New Bot" onClick={onHire}>
          <Icon name="plus" />
        </button>
      </div>
      {needle === "" ? (
        <div className="tiles">
          {groups.hq === null ? null : tile(groups.hq)}
          {groups.pinned.map(tile)}
        </div>
      ) : null}

      <nav className="roster">
        {rows.length === 0 ? (
          <p className="roster-empty">No Bots match.</p>
        ) : (
          <>
            {needle === "" ? null : (
              <>
                {groups.hq === null ? null : row(groups.hq)}
                {groups.pinned.map(row)}
              </>
            )}
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
        <HealthNote health={health} members={members} />
        <UpdateNote />
        {editingName !== null ? (
          <form
            className="me-name-form"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await api("/bot/v1/profile", { method: "PATCH", body: JSON.stringify({ name: editingName }) });
                await onChanged();
              } catch {
                // The sidebar keeps its old name; the next refresh tells the truth.
              }
              setEditingName(null);
            }}
          >
            <input
              value={editingName}
              onChange={(event) => setEditingName(event.target.value)}
              onBlur={() => setEditingName(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditingName(null);
              }}
              placeholder="Your name"
              maxLength={80}
              aria-label="Your name"
              autoFocus
            />
          </form>
        ) : null}
        <div className="dock-bar">
          <div className="me-wrap">
            <button
              type="button"
              className="me-btn"
              aria-haspopup="menu"
              aria-expanded={meOpen}
              title={profile === undefined || profile === null || profile.source === "none" ? "You" : profile.name}
              onClick={() => setMeOpen((value) => !value)}
            >
              {profile?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="me-avatar me-photo" src={profile.avatarUrl} alt="" width={30} height={30} />
              ) : (
                <span className="me-avatar">{(profile?.name ?? user ?? "You").charAt(0).toUpperCase()}</span>
              )}
            </button>
            {meOpen ? (
              <div className="menu me-menu" role="menu" onMouseLeave={() => setMeOpen(false)}>
                <div className="menu-head">
                  {profile === undefined || profile === null || profile.source === "none" ? "You" : profile.name}
                  {workspaceId === "default" ? "" : ` · ${workspaceId}`}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  disabled={profile?.source === "vercel" || profile?.source === "header"}
                  title={profile?.source === "vercel" ? "Signed in with Vercel" : profile?.source === "header" ? "Named by the caller" : undefined}
                  onClick={() => {
                    setMeOpen(false);
                    setEditingName(profile?.source === "workspace" ? (profile.name ?? "") : "");
                  }}
                >
                  <Icon name="edit" size={14} />
                  {profile === undefined || profile === null || profile.source === "none" ? "Set your name" : "Change your name"}
                </button>
                <button type="button" role="menuitem" onClick={toggleTheme}>
                  <Icon name={theme === "dark" ? "sun" : "moon"} size={14} />
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </button>
                <hr />
                <form method="post" action="/bot/v1/session/end">
                  <button type="submit" role="menuitem">
                    <Icon name="signout" size={14} />
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
          <button type="button" className="connect-pill" onClick={onConnectors} title={apps.connected ? "Your connected apps" : "Connect the apps your team uses"}>
            {apps.connected ? "Apps" : "Connect apps"}
            <span className="app-dots" aria-hidden="true">
              {apps.list.slice(0, 3).map((app) => (
                <BrandMark key={app.key} brand={app.brand} label={app.label} url={app.url} size={18} />
              ))}
            </span>
          </button>
          <button type="button" className="icon-btn" aria-label="Memory" title="Memory" onClick={onMemory}>
            <Icon name="brain" />
          </button>
          <button type="button" className="icon-btn" aria-label="Usage" title="Usage" onClick={onUsage}>
            <Icon name="chart" size={15} />
          </button>
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

/**
 * A line in the footer when work that should be moving is not: a job past its
 * start time with nothing holding it, or a run whose worker stopped. The
 * watchdog picks both up on its next pass; this says so before then.
 */
function HealthNote({ health, members }: { health: Board["health"] | undefined; members: readonly Member[] }) {
  if (health === undefined) return null;
  const count = health.overdue.length + health.staleRuns.length;
  if (count === 0) return null;
  const name = (botId: string) => members.find((member) => member.id === botId)?.name ?? botId;
  const lines = [
    ...health.overdue.map((job) => `${name(job.botId)}: "${job.title}" is ${job.lateMinutes} min overdue`),
    ...health.staleRuns.map((job) => `${name(job.botId)}: "${job.title}" stopped mid-run`),
  ];
  return (
    <div className="side-item side-health" title={`${lines.join("\n")}\nThe watchdog retries these on its next pass.`}>
      <Icon name="alert" size={15} />
      {count === 1 ? "1 job is stuck" : `${count} jobs are stuck`}
    </div>
  );
}

/**
 * A line in the footer when the original EVE Bot is newer than this one. A
 * deployment made with the Vercel button is a copy of the repository and
 * learns about releases only by asking; the answer is cached on the server.
 */
function UpdateNote() {
  const [update, setUpdate] = useState<{ latest: string; version: string; howToUpdate: string; runsItself: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api("/bot/v1/version");
        const body: unknown = await response.json().catch(() => null);
        if (
          !cancelled &&
          response.ok &&
          typeof body === "object" &&
          body !== null &&
          (body as { updateAvailable?: unknown }).updateAvailable === true &&
          typeof (body as { latest?: unknown }).latest === "string"
        ) {
          const report = body as { latest: string; version: string; howToUpdate: string; runsItself?: boolean };
          setUpdate({ latest: report.latest, version: report.version, howToUpdate: report.howToUpdate, runsItself: report.runsItself === true });
        }
      } catch {
        // No note is the right answer when the check cannot run.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (update === null) return null;
  return (
    <a
      className="side-item side-update"
      href={update.howToUpdate}
      target="_blank"
      rel="noopener noreferrer"
      title={
        update.runsItself
          ? `You run ${update.version}; ${update.latest} is out. Opens your repository's sync workflow: press "Run workflow" and Vercel redeploys.`
          : `You run ${update.version}; ${update.latest} is out. How to update.`
      }
    >
      <Icon name="up" size={15} />
      {update.runsItself ? `Update now to ${update.latest}` : `Update to ${update.latest}`}
    </a>
  );
}
