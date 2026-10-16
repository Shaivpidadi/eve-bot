import type RFB from "@novnc/novnc";

/**
 * The team's one live screen connection, kept between views.
 *
 * Every Bot shares one screen, so the picture does not change with the Bot you
 * open; what changes is which tab is in front, and the server does that when
 * a view asks. Closing the computer used to drop the connection, so opening it
 * again (from another thread, or the same one) waited on a new token and a
 * fresh VNC handshake. Now the closing view parks its live connection here,
 * still rendering into its own element, and the next view adopts it at once.
 * A parked connection nobody adopts is dropped after a minute, so a console
 * left open costs nothing once you stop watching.
 */

const KEEP_MS = 60_000;

export interface Parked {
  readonly client: RFB;
  /** The element noVNC renders into; moved between views. */
  readonly host: HTMLDivElement;
  /** What the token allowed: a view-only connection is never adopted for control. */
  readonly access: "view" | "control";
  /** Who hears that the connection dropped: the view holding it, if any. */
  onDrop: (() => void) | null;
  /** Who gets text copied on the computer: the view holding it, if any. */
  onClipboard: ((text: string) => void) | null;
}

let parked: Parked | null = null;
let timer: number | undefined;

/** Leaves a live connection for the next view. Replaces (and drops) any already parked. */
export function park(entry: Parked): void {
  if (parked !== null && parked !== entry) parked.client.disconnect();
  window.clearTimeout(timer);
  entry.onClipboard = null;
  entry.onDrop = () => {
    if (parked === entry) parked = null;
  };
  entry.host.remove();
  parked = entry;
  timer = window.setTimeout(() => {
    if (parked !== entry) return;
    parked = null;
    entry.client.disconnect();
  }, KEEP_MS);
}

/** The parked connection, for a view that wants `access`; it is no longer parked once taken. */
export function adopt(access: "view" | "control"): Parked | null {
  if (parked === null || (access === "control" && parked.access !== "control")) return null;
  const entry = parked;
  parked = null;
  window.clearTimeout(timer);
  return entry;
}
