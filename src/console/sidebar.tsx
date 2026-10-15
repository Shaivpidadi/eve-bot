"use client";

import {
  ArrowUpIcon,
  BrainIcon,
  ChartColumnIcon,
  CopyIcon,
  EllipsisIcon,
  EraserIcon,
  EyeOffIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  LogOutIcon,
  MailIcon,
  MailOpenIcon,
  MoonIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserIcon,
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from "react";

import { Avatar as UserAvatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { BrandMark } from "./brands";

import { api, errorMessage, SignedOutError } from "./api";
import { LiveAvatar } from "./live-avatar";
import { shortWhen, withoutEmoji } from "./format";
import { PromptDialog, type Prompt } from "./prompt-dialog";
import { roomStore } from "./room-store";
import { useTheme } from "./theme";
import type { Board, Hover, Member, Profile } from "./types";

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
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const signOut = useRef<HTMLFormElement>(null);
  // The row or tile under the pointer, whose face is alive.
  const [hovered, setHovered] = useState<string | null>(null);
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

  const menuFor = (member: Member, kit: MenuKit) => (
    <RowMenuItems
      kit={kit}
      member={member}
      sections={sectionNames}
      isUnread={unread.has(member.id)}
      onPin={(target) => void act(patch(target, { pinned: !target.pinned }, "Could not pin the Bot."))}
      onSection={(target, section) => void act(patch(target, { section }, "Could not move the Bot."))}
      onNewSection={(target) =>
        setPrompt({
          title: "New section",
          description: `${target.name} moves into it. Sections group Bots in the roster.`,
          label: "Section name",
          placeholder: "Sales",
          maxLength: 40,
          confirm: "Create",
          onConfirm: (value) => patch(target, { section: value }, "Could not create the section."),
        })
      }
      onUnread={(target) => onUnread(target.id, !unread.has(target.id))}
      onRename={(target) =>
        setPrompt({
          title: "Rename Bot",
          description: "Bots are addressed by name in every thread, so pick one the team will recognise.",
          label: "Name",
          defaultValue: target.name,
          maxLength: 40,
          confirm: "Rename",
          onConfirm: (value) => patch(target, { name: value }, "Could not rename the Bot."),
        })
      }
      onEditProfile={(target) => onEditProfile(target.id)}
      onDuplicate={(target) =>
        void act(
          (async () => {
            try {
              const response = await api(`/bot/v1/bots/${encodeURIComponent(target.id)}/duplicate`, { method: "POST" });
              if (!response.ok) return await errorMessage(response, "Could not duplicate the Bot.");
              const created = (await response.json()) as { bot: { id: string } };
              await onChanged();
              // The copy opens with its profile in edit, since a copy is made to be changed.
              onEditProfile(created.bot.id);
              return null;
            } catch (caught) {
              return caught instanceof SignedOutError ? null : "Could not duplicate the Bot.";
            }
          })(),
        )
      }
      onClearChat={(target) =>
        setPrompt({
          title: `Clear chat with ${target.name}?`,
          description:
            target.kind === "hq"
              ? "HQ's desk starts over: the conversation is cleared and its open one-off jobs are cancelled. The roster, finished work, and memory stay."
              : `${target.name}'s thread starts over: the conversation is cleared and its open one-off jobs are cancelled. ${target.name}, its finished work, and what it learned stay.`,
          confirm: "Clear chat",
          danger: true,
          onConfirm: async () => {
            try {
              const response = await api(`/bot/v1/rooms/${encodeURIComponent(target.room)}/reset`, { method: "POST" });
              if (!response.ok) return await errorMessage(response, "Could not clear the chat.");
              // The open transcript, if it is this one, empties at once rather than on the next poll.
              roomStore(target.room).restart();
              onUnread(target.id, false);
              await onChanged();
              return null;
            } catch (caught) {
              return caught instanceof SignedOutError ? null : "Could not clear the chat.";
            }
          },
        })
      }
      onCopyId={(target) =>
        void act(
          navigator.clipboard
            .writeText(target.room)
            .then(() => {
              setNotice(`Copied ${target.room}`);
              return null;
            })
            .catch(() => `Could not copy. The conversation id is ${target.room}.`),
        )
      }
      onHide={(target) => void act(patch(target, { hidden: !target.hidden }, "Could not hide the Bot."))}
      onDelete={(target) =>
        setPrompt({
          title: `Delete ${target.name}?`,
          description: `${target.name} leaves the team for good: its open jobs are cancelled and what it learned is discarded. Its thread stays readable. Pausing keeps everything if you might want it back.`,
          confirm: "Delete",
          danger: true,
          onConfirm: async () => {
            try {
              const response = await api(`/bot/v1/bots/${encodeURIComponent(target.id)}`, { method: "DELETE" });
              if (!response.ok) return await errorMessage(response, "Could not delete the Bot.");
              await onChanged();
              if (target.id === selectedId) onSelect("hq");
              return null;
            } catch (caught) {
              return caught instanceof SignedOutError ? null : "Could not delete the Bot.";
            }
          },
        })
      }
    />
  );

  const row = (member: Member) => {
    const preview = withoutEmoji(member.preview?.text ?? member.title);
    const needsYou = member.pending > 0 || member.presence === "waiting";
    const isUnread = unread.has(member.id) && member.id !== selectedId;
    const paused = member.status === "paused";
    return (
      <ContextMenu key={member.id}>
        {/* A right-click anywhere on the row opens its menu; so does the ⋯ that appears on hover. */}
        <ContextMenuTrigger className="group/row relative select-auto">
          <button
            type="button"
            className="row flex w-full cursor-pointer items-center gap-[11px] rounded-xl px-[9px] py-2 text-left transition-colors hover:bg-sidebar-accent aria-[current=true]:bg-selected"
            aria-current={member.id === selectedId}
            onClick={() => onSelect(member.id)}
            onPointerEnter={() => setHovered(member.id)}
            onPointerLeave={() => setHovered((current) => (current === member.id ? null : current))}
          >
            <LiveAvatar member={member} size={32} alive={hovered === member.id} onHover={onHover} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", paused && "text-muted-foreground")}>
                  {isUnread ? <span className="mr-1.5 inline-block size-[7px] rounded-full bg-brand align-[1px]" aria-label="Unread" /> : null}
                  {member.name}
                  {member.pinned ? <PinIcon className="ml-1 inline size-[11px] align-[-1px] text-faint" aria-label="Pinned" /> : null}
                </span>
                <time className="flex-none text-[10.5px] text-faint tabular-nums group-hover/row:invisible group-has-data-popup-open/row:invisible group-data-popup-open/row:invisible">
                  {shortWhen(member.preview?.at)}
                </time>
              </span>
              <span className={cn("mt-px block truncate text-xs text-muted-foreground", (needsYou || isUnread) && "text-foreground")}>
                {paused ? `Paused · ${preview}` : preview}
              </span>
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-[5px] right-1.5 bg-sidebar-accent text-muted-foreground opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-popup-open/row:opacity-100 data-popup-open:opacity-100"
                  aria-label={`Options for ${member.name}`}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {menuFor(member, DROPDOWN_KIT)}
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">{menuFor(member, CONTEXT_KIT)}</ContextMenuContent>
      </ContextMenu>
    );
  };

  const head = (title: string) => (
    <div className="px-2 pt-2.5 pb-[3px] text-[10.5px] font-semibold tracking-[0.04em] text-faint uppercase">{title}</div>
  );

  /** HQ and pinned Bots, as tiles above the list: the ones used most, a click away. */
  const tile = (member: Member) => {
    const needsYou = member.pending > 0 || member.presence === "waiting";
    const isUnread = unread.has(member.id) && member.id !== selectedId;
    const face = (
      <button
        key={member.id}
        type="button"
        className="tile relative flex w-full cursor-pointer flex-col items-center gap-[5px] rounded-[14px] px-1 pt-2.5 pb-2 transition-[background-color,transform] duration-150 hover:bg-sidebar-accent active:scale-[0.97] aria-[current=true]:bg-selected"
        aria-current={member.id === selectedId}
        title={member.title}
        onClick={() => onSelect(member.id)}
        onPointerEnter={() => setHovered(member.id)}
        onPointerLeave={() => setHovered((current) => (current === member.id ? null : current))}
      >
        <LiveAvatar member={member} size={40} alive={hovered === member.id} onHover={onHover} />
        <span className={cn("max-w-full truncate text-xs font-medium", member.status === "paused" && "text-muted-foreground")}>
          {member.name}
        </span>
        {needsYou || isUnread ? (
          <span
            className={cn(
              "absolute top-2 right-3.5 size-[9px] rounded-full shadow-[0_0_0_2px_var(--sidebar)]",
              needsYou ? "bg-warning" : "bg-brand",
            )}
            aria-label={needsYou ? "Needs you" : "Unread"}
          />
        ) : null}
      </button>
    );
    if (member.kind !== "bot") return face;
    return (
      <ContextMenu key={member.id}>
        <ContextMenuTrigger className="select-auto">{face}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">{menuFor(member, CONTEXT_KIT)}</ContextMenuContent>
      </ContextMenu>
    );
  };

  const meName = profile === undefined || profile === null || profile.source === "none" ? "You" : profile.name;

  return (
    <aside className="flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground" aria-label="Your Bots">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2.5">
        <InputGroup className="h-8 flex-1 rounded-full border-transparent bg-secondary dark:bg-secondary">
          <InputGroupAddon className="pl-3 text-faint">
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Search"
            autoComplete="off"
            aria-label="Search Bots"
            className="text-[12.5px] placeholder:text-faint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <Button variant="outline" size="icon" className="size-[30px] rounded-full bg-card" aria-label="New Bot" title="New Bot" onClick={onHire}>
          <PlusIcon />
        </Button>
      </div>
      {needle === "" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1.5 px-3 pb-2.5">
          {groups.hq === null ? null : tile(groups.hq)}
          {groups.pinned.map(tile)}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <nav className="px-1.5 pt-0.5 pb-2">
          {rows.length === 0 ? (
            <p className="m-0 p-2.5 text-xs text-faint">No Bots match.</p>
          ) : (
            <>
              {needle === "" ? null : (
                <>
                  {groups.hq === null ? null : row(groups.hq)}
                  {groups.pinned.map(row)}
                </>
              )}
              {groups.sections.map(([name, bots]) => (
                <div key={`section:${name}`}>
                  {head(name)}
                  {bots.map(row)}
                </div>
              ))}
              {groups.grouping && groups.rest.length > 0 ? head("Bots") : null}
              {groups.rest.map(row)}
              {groups.hidden.length > 0 ? (
                <>
                  <Button
                    variant="ghost"
                    className="mt-1.5 h-auto w-full justify-start gap-1.5 px-2 py-[7px] text-[11.5px] font-normal text-faint hover:text-muted-foreground"
                    onClick={() => setShowHidden((value) => !value)}
                  >
                    <EyeOffIcon className="size-3" />
                    {showHidden ? "Hide hidden Bots" : `Hidden (${groups.hidden.length})`}
                  </Button>
                  {showHidden ? groups.hidden.map(row) : null}
                </>
              ) : null}
            </>
          )}
        </nav>
      </ScrollArea>

      {notice === null ? null : (
        <p className="mx-2.5 mt-0 mb-1.5 rounded-lg border border-input bg-card px-2 py-1.5 text-[11.5px] text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      <div className="relative flex flex-col gap-1 px-2.5 pt-1.5 pb-3">
        <HealthNote health={health} members={members} />
        <UpdateNote />
        {editingName !== null ? (
          <form
            className="mb-1"
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
            <Input
              className="h-7 text-[12.5px]"
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
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-[30px] flex-none rounded-full p-0 transition-transform hover:scale-105 hover:bg-transparent"
                  title={meName}
                  aria-label="You"
                />
              }
            >
              <UserAvatar className="size-[30px]">
                {profile?.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt="" /> : null}
                <AvatarFallback className="bg-linear-135 from-[#c9a37c] to-[#7d5a44] text-xs font-semibold text-white">
                  {(profile?.name ?? user ?? "You").charAt(0).toUpperCase()}
                </AvatarFallback>
              </UserAvatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {meName}
                  {workspaceId === "default" ? "" : ` · ${workspaceId}`}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={profile?.source === "vercel" || profile?.source === "header"}
                  title={profile?.source === "vercel" ? "Signed in with Vercel" : profile?.source === "header" ? "Named by the caller" : undefined}
                  onClick={() => setEditingName(profile?.source === "workspace" ? (profile.name ?? "") : "")}
                >
                  <PencilIcon />
                  {meName === "You" ? "Set your name" : "Change your name"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleTheme}>
                  {theme === "dark" ? <SunIcon /> : <MoonIcon />}
                  {theme === "dark" ? "Light theme" : "Dark theme"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => signOut.current?.requestSubmit()}>
                <LogOutIcon />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <form ref={signOut} method="post" action="/bot/v1/session/end" hidden />
          <Button
            variant="outline"
            className="h-[34px] min-w-0 flex-1 gap-[7px] rounded-full bg-card px-2 text-[12.5px] font-medium shadow-xs transition-[box-shadow,transform] hover:bg-card hover:shadow-md active:scale-[0.98] dark:bg-card dark:hover:bg-card"
            onClick={onConnectors}
            title={apps.connected ? "Your connected apps" : "Connect the apps your team uses"}
          >
            <span className="min-w-0 text-center leading-[1.15] whitespace-normal">{apps.connected ? "Apps" : "Connect apps"}</span>
            <span className="inline-flex flex-none *:-ml-0.5 *:ring-2 *:ring-card *:first:ml-0" aria-hidden="true">
              {apps.list.slice(0, 3).map((app) => (
                <BrandMark key={app.key} brand={app.brand} label={app.label} url={app.url} size={18} />
              ))}
            </span>
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Memory" title="Memory" onClick={onMemory}>
            <BrainIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Usage" title="Usage" onClick={onUsage}>
            <ChartColumnIcon />
          </Button>
        </div>
      </div>

      <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} />
    </aside>
  );
}

/**
 * The parts a row's menu is built from. The ⋯ button opens a dropdown and a
 * right-click a context menu; both list the same items.
 */
interface MenuKit {
  readonly Item: ComponentType<{ onClick?: () => void; disabled?: boolean; variant?: "default" | "destructive"; children: ReactNode }>;
  readonly Separator: ComponentType;
  readonly Group: ComponentType<{ children: ReactNode }>;
  readonly Label: ComponentType<{ children: ReactNode }>;
  readonly Sub: ComponentType<{ children: ReactNode }>;
  readonly SubTrigger: ComponentType<{ children: ReactNode }>;
  readonly SubContent: ComponentType<{ className?: string; children: ReactNode }>;
}

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/** The row menu: what you can do to a Bot without opening its thread. */
function RowMenuItems({
  kit: { Item, Separator, Group, Label, Sub, SubTrigger, SubContent },
  member,
  sections,
  isUnread,
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
  kit: MenuKit;
  member: Member;
  sections: readonly string[];
  isUnread: boolean;
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
  const bot = member.kind === "bot";
  const others = sections.filter((name) => name !== member.section);
  return (
    <>
      <Group>
        {bot ? (
          <Item onClick={() => onPin(member)}>
            <PinIcon />
            {member.pinned ? "Unpin" : "Pin"}
          </Item>
        ) : null}
        {bot ? (
          <Sub>
            <SubTrigger>
              <FolderIcon />
              {others.length > 0 || member.section !== null ? "Move to section" : "Move to new section"}
            </SubTrigger>
            <SubContent className="w-48">
              <Group>
                {others.length > 0 ? <Label>Move to</Label> : null}
                {others.map((name) => (
                  <Item key={name} onClick={() => onSection(member, name)}>
                    <FolderIcon />
                    {name}
                  </Item>
                ))}
                <Item onClick={() => onNewSection(member)}>
                  <FolderPlusIcon />
                  New section…
                </Item>
                {member.section === null ? null : (
                  <Item onClick={() => onSection(member, null)}>
                    <FolderMinusIcon />
                    {`Remove from ${member.section}`}
                  </Item>
                )}
              </Group>
            </SubContent>
          </Sub>
        ) : null}
        <Item onClick={() => onUnread(member)}>
          {isUnread ? <MailOpenIcon /> : <MailIcon />}
          {isUnread ? "Mark as read" : "Mark as unread"}
        </Item>
        <Item onClick={() => onClearChat(member)}>
          <EraserIcon />
          Clear chat
        </Item>
      </Group>
      {bot ? (
        <>
          <Separator />
          <Group>
            <Item onClick={() => onRename(member)}>
              <PencilIcon />
              Rename Bot
            </Item>
            <Item onClick={() => onEditProfile(member)}>
              <UserIcon />
              Edit profile
            </Item>
            <Item onClick={() => onDuplicate(member)}>
              <CopyIcon />
              Duplicate
            </Item>
          </Group>
        </>
      ) : null}
      <Separator />
      <Item onClick={() => onCopyId(member)}>
        <CopyIcon />
        Copy conversation ID
      </Item>
      {bot ? (
        <>
          <Separator />
          <Group>
            <Item onClick={() => onHide(member)}>
              <EyeOffIcon />
              {member.hidden ? "Show in sidebar" : "Hide from sidebar"}
            </Item>
            <Item variant="destructive" onClick={() => onDelete(member)}>
              <Trash2Icon />
              Delete
            </Item>
          </Group>
        </>
      ) : null}
    </>
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
    <div
      className="flex w-full cursor-default items-center gap-[9px] rounded-lg px-2 py-[7px] text-[12.5px] text-warning"
      title={`${lines.join("\n")}\nThe watchdog retries these on its next pass.`}
    >
      <TriangleAlertIcon className="size-[15px] flex-none" />
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
      className="flex w-full items-center gap-[9px] rounded-lg px-2 py-[7px] text-[12.5px] text-brand no-underline hover:bg-sidebar-accent"
      href={update.howToUpdate}
      target="_blank"
      rel="noopener noreferrer"
      title={
        update.runsItself
          ? `You run ${update.version}; ${update.latest} is out. Opens your repository's sync workflow: press "Run workflow" and Vercel redeploys.`
          : `You run ${update.version}; ${update.latest} is out. How to update.`
      }
    >
      <ArrowUpIcon className="size-[15px] flex-none" />
      {update.runsItself ? `Update now to ${update.latest}` : `Update to ${update.latest}`}
    </a>
  );
}
