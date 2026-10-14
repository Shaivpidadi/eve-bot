"use client";

import { createContext, type CSSProperties, type ReactNode, useContext } from "react";

import { cn } from "@/lib/utils";

import { memberColor } from "./avatar";
import type { Member } from "./types";

/**
 * Tagging teammates: "@Ava" in a message. The person tags someone to hand them
 * the work or to bring them in, and the server routes on it (see
 * `agent/lib/routing.ts`). Here it is drawn as a chip in the teammate's colour.
 */
export const TeamContext = createContext<readonly Member[]>([]);

export const useTeam = () => useContext(TeamContext);

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches "@Name" for every teammate, longest names first so "@Ava Ops" beats "@Ava". */
function mentionPattern(team: readonly Member[]): RegExp | null {
  const names = [...new Set(team.map((member) => member.name.trim()).filter((name) => name !== ""))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@(${names.map(escape).join("|")})(?=$|[^\\p{L}\\p{N}_])`, "giu");
}

const byName = (team: readonly Member[], name: string) => team.find((member) => member.name.toLowerCase() === name.toLowerCase());

/** A tag as a chip in the teammate's colour; on a coloured bubble (yours) it is drawn in white. */
export function MentionChip({ member, onColor = false }: { member: Member; onColor?: boolean }) {
  return (
    <span
      className={cn(
        "mx-px inline-block rounded-md px-1.5 font-semibold whitespace-nowrap",
        onColor
          ? "bg-white/20 text-white"
          : "bg-[color-mix(in_srgb,var(--mc)_15%,transparent)] text-[color-mix(in_srgb,var(--mc)_78%,var(--foreground))]",
      )}
      style={{ "--mc": memberColor(member) } as CSSProperties}
    >
      @{member.name}
    </span>
  );
}

/** Plain text with every tag drawn as a chip. */
export function MentionText({ text, onColor = false }: { text: string; onColor?: boolean }) {
  const team = useTeam();
  const pattern = mentionPattern(team);
  if (pattern === null) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const member = byName(team, match[2] ?? "");
    if (member === undefined) continue;
    out.push(text.slice(last, start), <MentionChip key={start} member={member} onColor={onColor} />);
    last = start + 1 + (match[2]?.length ?? 0);
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** Markdown with tags turned into links the prose renderer draws as chips. */
export function linkMentions(text: string, team: readonly Member[]): string {
  const pattern = mentionPattern(team);
  if (pattern === null) return text;
  return text.replace(pattern, (whole, lead: string, name: string) => {
    const member = byName(team, name);
    return member === undefined ? whole : `${lead}[@${member.name}](mention:${encodeURIComponent(member.id)})`;
  });
}

export const MENTION_HREF = /^mention:(.+)$/;

/** The "@que" being typed just before the caret, if any. */
export function typedMention(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([\p{L}\p{N}_ .-]{0,24})$/u.exec(text.slice(0, caret));
  if (match === null) return null;
  const query = match[2] ?? "";
  // A space ends a tag unless it is still part of a teammate's name.
  return { start: caret - query.length - 1, query };
}

/** Teammates matching what is typed after "@": names that start with it first. */
export function mentionChoices(team: readonly Member[], query: string, self: string): Member[] {
  const needle = query.trim().toLowerCase();
  return team
    .filter((member) => member.id !== self && member.status !== "paused")
    .filter((member) => needle === "" || member.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(needle)) - Number(a.name.toLowerCase().startsWith(needle)))
    .slice(0, 6);
}
