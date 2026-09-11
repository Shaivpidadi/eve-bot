import { deleteDoc, readDoc, writeDoc } from "./store";

/**
 * The latest frame of a bot's screen, so the operator can glance at its
 * computer without taking it over. One frame per teammate session, overwritten
 * as the bot works; the model never sees these.
 */
export const MAX_SCREEN_BYTES = 1_500_000;

export interface Screen {
  readonly at: string;
  readonly mediaType: string;
  readonly base64: string;
}

const key = (workspaceId: string, name: string) => `screens/${workspaceId}/${name}.json`;

/** Frames are kept per Bot: each Bot's own tab in the shared browser has its own still frame. */
export const posterKey = (botId: string) => `bot-${botId}`;

export async function saveScreen(
  workspaceId: string,
  sessionId: string,
  bytes: Uint8Array,
  mediaType = "image/png",
): Promise<boolean> {
  if (bytes.byteLength > MAX_SCREEN_BYTES) return false;
  const screen: Screen = {
    at: new Date().toISOString(),
    mediaType,
    base64: Buffer.from(bytes).toString("base64"),
  };
  await writeDoc(key(workspaceId, sessionId), screen);
  return true;
}

export async function readScreen(workspaceId: string, sessionId: string): Promise<Screen | null> {
  return (await readDoc<Screen>(key(workspaceId, sessionId)))?.value ?? null;
}

export async function deleteScreen(workspaceId: string, sessionId: string): Promise<void> {
  await deleteDoc(key(workspaceId, sessionId));
}
