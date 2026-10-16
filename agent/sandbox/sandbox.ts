import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox, type SandboxSession } from "eve/sandbox";

import { COMPUTER_PATHS } from "../lib/computer";
import { AGENT_BROWSER_INSTALL, computerEnvironment, computerOpenOptions } from "../lib/computer-config";
import { sandboxHands } from "../lib/hands";
import { COMPUTER_SCRIPT, COMPUTER_SOFTWARE_REVISION } from "../lib/computer/script";

/**
 * The team's computer: one persistent machine that HQ, every Bot's thread, and
 * every teammate at work share (see `lib/team-computer.ts`), with one browser
 * the whole team uses, which people can watch and take over from any thread,
 * and a terminal (see `lib/computer/`).
 *
 * It runs on Vercel Sandbox by default, in development too; `BOT_COMPUTER=local`
 * runs it in a container or VM on this machine instead (see
 * `lib/computer-config.ts`). On top of whatever the provider preserves,
 * `lib/computer-backup.ts` archives the computer to durable storage while Bots
 * work and restores it onto a replacement machine.
 */

/**
 * Runs once per environment generation: every new machine starts from the
 * snapshot or image this leaves behind, before any backup is restored onto it.
 * The software revisions are named here so a change to them makes a new
 * generation (eve hashes this function's source with the environment).
 */
async function prepare(sandbox: SandboxSession): Promise<void> {
  const revision = ["computer-v3", COMPUTER_SOFTWARE_REVISION, agentBrowserRevalidationKey(AGENT_BROWSER_INSTALL), process.env.BOT_SANDBOX_REVISION ?? "0"].join("-");
  const result = await sandbox.run({ command: `mkdir -p ${Object.values(COMPUTER_PATHS).join(" ")} && echo ${revision} > /dev/null` });
  if (result.exitCode !== 0) {
    // Throwing here stops eve from keeping a half-built snapshot.
    throw new Error(`Computer preparation failed: ${result.stderr || result.stdout}`);
  }
  if (process.env.BOT_SANDBOX_PREINSTALL_BROWSER === "0") return;
  try {
    // Bakes the browser, display, terminal and agent-browser into the snapshot so
    // the first job does not wait for the install. Machines that already exist
    // install the same software on first use.
    await sandboxHands(sandbox).setup.install();
    // agent-browser's types predate eve 0.79's session shape (no `id`); it only
    // names its own sessions by it, and we always pass ours.
    await installAgentBrowser(sandbox as never, AGENT_BROWSER_INSTALL);
  } catch (error) {
    // eve keeps what this machine looks like now as the template every new machine starts from.
    // An install still running in the background would leave a package half unpacked in it, so
    // it is stopped and dpkg left consistent; whatever it did not finish installs on first use.
    await Promise.resolve(sandbox.run({ command: `${COMPUTER_SCRIPT} settle` })).catch(() => undefined);
    console.warn("Could not preinstall the computer's software; it will install on first use.", error instanceof Error ? error.message : error);
  }
}

export const environment = computerEnvironment(prepare);

export default defineSandbox(() => environment.open(computerOpenOptions()));
