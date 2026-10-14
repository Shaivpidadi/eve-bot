import { newId } from "./ids";
import { deleteDoc, listDocs, updateDoc, writeDoc } from "./store";

/**
 * Messages waiting to go into a room: a teammate's note, or a job's wake-up
 * when its start time comes.
 *
 * Tools and workflow steps cannot open a session in another room themselves;
 * only a channel route or a schedule can. So they leave the message here, and
 * the next pass that can reach a room delivers it as a turn of its own: the
 * internal flush a step asks for at once (see `self.ts`), the console's board
 * poll, a message sent from the console, or the watchdog. Each is claimed,
 * delivered and removed; a pass that dies mid-way leaves the claim to lapse.
 */
export interface Outgoing {
  readonly id: string;
  readonly workspaceId: string;
  readonly room: string;
  readonly message: string;
  readonly at: string;
  readonly claimedAt?: string | null;
}

const CLAIM_MS = 60_000;
const key = (workspaceId: string, id: string) => `outbox/${workspaceId}/${id}.json`;

export async function enqueue(input: { readonly workspaceId: string; readonly room: string; readonly message: string; readonly id?: string }): Promise<Outgoing> {
  const item: Outgoing = {
    id: input.id ?? newId("out"),
    workspaceId: input.workspaceId,
    room: input.room,
    message: input.message,
    at: new Date().toISOString(),
    claimedAt: null,
  };
  await writeDoc(key(item.workspaceId, item.id), item, null);
  return item;
}

export async function deliverOutbox(
  send: (workspaceId: string, room: string, message: string) => Promise<void>,
  options: { readonly workspaceId?: string; readonly now?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const waiting = await listDocs<Outgoing>(options.workspaceId === undefined ? "outbox/" : `outbox/${options.workspaceId}/`);
  let delivered = 0;
  for (const item of waiting.sort((left, right) => left.at.localeCompare(right.at))) {
    let mine = false;
    await updateDoc<Outgoing>(key(item.workspaceId, item.id), (current) => {
      if (current === null) return null;
      if (current.claimedAt != null && now - Date.parse(current.claimedAt) < CLAIM_MS) return null;
      mine = true;
      return { ...current, claimedAt: new Date(now).toISOString() };
    });
    if (!mine) continue;
    try {
      await send(item.workspaceId, item.room, item.message);
      await deleteDoc(key(item.workspaceId, item.id));
      delivered += 1;
    } catch {
      // Left claimed; it is retried once the claim lapses.
    }
  }
  return delivered;
}
