import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defineSandbox } from "eve/sandbox";

import { COMPUTER_PATHS } from "../lib/computer";
import { AGENT_BROWSER_INSTALL, computerBackend, computerMode } from "../lib/computer-config";
import { installSoftware, sandboxIo } from "../lib/computer/runtime";
import { COMPUTER_SOFTWARE_REVISION } from "../lib/computer/script";

/**
 * The team's computer: one persistent machine that HQ, every Bot's thread, and
 * every teammate at work share (see `lib/computer.ts`), with one browser the
 * whole team uses, which people can watch and take over from any thread, and a
 * terminal (see `lib/computer/`).
 *
 * It runs on Vercel Sandbox by default, in development too; `BOT_COMPUTER=local`
 * runs it in a VM on this machine instead (see `lib/computer-config.ts`). On
 * top of whatever the backend preserves, `lib/computer-backup.ts` archives the
 * computer to durable storage while Bots work and restores it onto a
 * replacement machine.
 */
export default defineSandbox({
  backend: computerBackend(),
  revalidationKey: () =>
    [
      "computer-v2",
      computerMode(),
      process.env.BOT_SANDBOX_REVISION ?? "0",
      COMPUTER_SOFTWARE_REVISION,
      agentBrowserRevalidationKey(AGENT_BROWSER_INSTALL),
    ].join("-"),

  /**
   * Runs once per template: every new computer starts from the snapshot this
   * leaves behind, before any backup is restored onto it.
   */
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({
      command: `mkdir -p ${Object.values(COMPUTER_PATHS).join(" ")}`,
    });
    if (result.exitCode !== 0) {
      // Throwing here stops eve from caching a half-built template.
      throw new Error(`Sandbox bootstrap failed: ${result.stderr || result.stdout}`);
    }

    if (process.env.BOT_SANDBOX_PREINSTALL_BROWSER === "0") return;
    try {
      // Bakes the browser, display, terminal and agent-browser into the template
      // so the first job does not wait for the install. Computers that already
      // exist install the same software on first use.
      await installSoftware(sandboxIo(sandbox));
      await installAgentBrowser(sandbox, AGENT_BROWSER_INSTALL);
    } catch (error) {
      console.warn(
        "Could not preinstall the computer's software; it will install on first use.",
        error instanceof Error ? error.message : error,
      );
    }
  },
});
