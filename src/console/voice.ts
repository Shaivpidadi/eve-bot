/**
 * When each thread last received streamed reply text, so a face can talk while
 * its Bot's reply arrives (see `mascot.tsx`). The room store notes each delta;
 * nothing renders from this, a face reads it on its next frame.
 */
const lastSpoke = new Map<string, number>();

export function spoke(room: string): void {
  lastSpoke.set(room, performance.now());
}

/** Whether `room` received reply text in the last `withinMs`. */
export function speaking(room: string, withinMs = 450): boolean {
  const at = lastSpoke.get(room);
  return at !== undefined && performance.now() - at < withinMs;
}
