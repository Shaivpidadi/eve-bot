"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, SignedOutError } from "./api";
import type { ActivityEvent, BoardResponse, Member } from "./types";

export interface BoardState {
  readonly workspaceId: string;
  readonly user: string;
  readonly members: readonly Member[];
  /** Oldest first. */
  readonly activity: readonly ActivityEvent[];
}

const ACTIVITY_LIMIT = 1_200;
const POLL_MS = 3_000;
const HIDDEN_POLL_MS = 15_000;

/**
 * Polls the roster and feed. The feed is fetched incrementally: after the first
 * read, each poll asks only for events since the newest one it has.
 */
export function useBoard(): { board: BoardState | null; online: boolean; refresh: () => Promise<void> } {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [online, setOnline] = useState(true);
  const events = useRef(new Map<string, ActivityEvent>());
  const cursor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const query = cursor.current === null ? "" : `?after=${encodeURIComponent(cursor.current)}`;
      const response = await api(`/bot/v1/state${query}`);
      if (!response.ok) throw new Error(`state ${response.status}`);
      const next = (await response.json()) as BoardResponse;

      for (const event of next.activity) {
        events.current.set(event.id, event);
        if (cursor.current === null || event.at > cursor.current) cursor.current = event.at;
      }
      const activity = [...events.current.values()].sort((left, right) => left.at.localeCompare(right.at));
      for (const stale of activity.splice(0, Math.max(0, activity.length - ACTIVITY_LIMIT))) {
        events.current.delete(stale.id);
      }

      setBoard({ workspaceId: next.workspaceId, user: next.user, members: next.members, activity });
      setOnline(true);
    } catch (error) {
      if (!(error instanceof SignedOutError)) setOnline(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      await refresh();
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    };
    const wake = () => {
      if (!document.hidden) void tick();
    };

    void tick();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  return { board, online, refresh };
}
