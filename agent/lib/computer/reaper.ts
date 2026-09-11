import { computerControl } from "./control";
import { stopScreen } from "./runtime";
import { liveControl, readScreens, setBrowserState } from "./screens";

/**
 * Stops browsers nobody has used for a while, so an idle computer is not
 * paying for Chrome on every screen. A stopped screen starts again, signed in,
 * the next time its Bot or a person needs it.
 *
 * Only a computer that is already running is touched: stopping screens is never
 * a reason to wake it.
 */
const IDLE_MS = Number(process.env.BOT_COMPUTER_IDLE_MINUTES ?? 15) * 60_000;
const EVERY_MS = 5 * 60_000;

let lastRun = 0;

export async function reapIdleScreens(): Promise<number> {
  if (Date.now() - lastRun < EVERY_MS) return 0;
  lastRun = Date.now();

  const idle = (await readScreens()).screens.filter(
    (screen) =>
      screen.browser.state !== "off" &&
      liveControl(screen) === null &&
      Date.now() - Date.parse(screen.lastUsedAt) > IDLE_MS,
  );
  if (idle.length === 0) return 0;

  const control = computerControl();
  if ((await control.availability()).state !== "running") return 0;
  const io = await control.io();
  if (io === null) return 0;

  let stopped = 0;
  for (const screen of idle) {
    try {
      await stopScreen(io, screen.n);
      await setBrowserState(screen.n, "off");
      stopped += 1;
    } catch {
      // Try again on the next pass.
    }
  }
  return stopped;
}
