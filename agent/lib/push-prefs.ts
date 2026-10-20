import { createHash } from "node:crypto";

import { readDoc, writeDoc } from "./store";

/**
 * What each person wants on their devices (docs/plan/notifications.md, N5),
 * per workspace: which kinds reach them, their quiet hours, and whether a
 * push waits while they are looking at the console. Unset, the defaults.
 */
export interface PushPrefs {
  /** A Bot asks for an approval or an answer, or a job waits on them. */
  readonly needsYou: boolean;
  /** A job finished, or failed for good. */
  readonly done: boolean;
  /** A Bot or HQ reaches out with news, through `notify`. */
  readonly fromBots: boolean;
  /** Quiet hours in the workspace's timezone, as whole hours; equal hours mean none. */
  readonly quietFrom: number;
  readonly quietTo: number;
  /** In Chrome, skip a push that is not urgent while the console is focused. */
  readonly onlyWhenAway: boolean;
}

export const DEFAULT_PREFS: PushPrefs = { needsYou: true, done: true, fromBots: true, quietFrom: 22, quietTo: 8, onlyWhenAway: true };

const prefsKey = (workspaceId: string, person: string) => `push-prefs/${workspaceId}/${createHash("sha256").update(person).digest("hex").slice(0, 16)}.json`;

const hour = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Fills in what is missing or out of range from the defaults. */
export function normalizePrefs(value: unknown): PushPrefs {
  const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    needsYou: flag(input.needsYou, DEFAULT_PREFS.needsYou),
    done: flag(input.done, DEFAULT_PREFS.done),
    fromBots: flag(input.fromBots, DEFAULT_PREFS.fromBots),
    quietFrom: hour(input.quietFrom, DEFAULT_PREFS.quietFrom),
    quietTo: hour(input.quietTo, DEFAULT_PREFS.quietTo),
    onlyWhenAway: flag(input.onlyWhenAway, DEFAULT_PREFS.onlyWhenAway),
  };
}

export async function readPrefs(workspaceId: string, person: string): Promise<PushPrefs> {
  return normalizePrefs((await readDoc<PushPrefs>(prefsKey(workspaceId, person)).catch(() => null))?.value);
}

export async function savePrefs(workspaceId: string, person: string, changes: unknown): Promise<PushPrefs> {
  const current = await readPrefs(workspaceId, person);
  const next = normalizePrefs({ ...current, ...(typeof changes === "object" && changes !== null ? changes : {}) });
  await writeDoc(prefsKey(workspaceId, person), next);
  return next;
}
