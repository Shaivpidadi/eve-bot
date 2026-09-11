import { agentBrowserRevalidationKey, installAgentBrowser } from "@agent-browser/eve/sandbox";
import { defaultBackend, defineSandbox } from "eve/sandbox";
import type { SandboxNetworkPolicy } from "eve/sandbox";

const allow = (process.env.BOT_SANDBOX_ALLOW_DOMAINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * Egress is open by default because the browser downloads itself and Chromium
 * on first use. Set BOT_SANDBOX_ALLOW_DOMAINS in production to fence the bot to
 * the hosts it actually needs — the policy is applied at the firewall, outside
 * the sandbox, so the bot cannot lift it.
 */
const networkPolicy: SandboxNetworkPolicy = allow.length > 0 ? { allow } : "allow-all";

/**
 * The bot's computer.
 *
 * On Vercel this is a Firecracker microVM (Vercel Sandbox); locally it falls
 * back to Docker, microsandbox, or the pure-JS just-bash interpreter — in that
 * order. Browser work needs real binaries, so the just-bash fallback can run a
 * shell but not Chromium: use Docker locally, or deploy.
 *
 * The filesystem persists for the life of the durable session, which is why a
 * bot can pick up a multi-day job where it left off. Anything that must outlive
 * the sandbox goes through `save_artifact`.
 */
export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      networkPolicy,
      resources: { vcpus: Number(process.env.BOT_SANDBOX_VCPUS ?? 2) },
    },
    docker: { networkPolicy: allow.length > 0 ? "deny-all" : "allow-all" },
  }),
  revalidationKey: () =>
    `teammate-v1-${process.env.BOT_SANDBOX_REVISION ?? "0"}-${agentBrowserRevalidationKey()}`,

  /**
   * Runs once per template, not per session: every later bot session starts from
   * the snapshot this leaves behind.
   */
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "mkdir -p /workspace/work /workspace/downloads /workspace/notes",
    });
    if (result.exitCode !== 0) {
      // Throwing here stops eve from caching a half-built template.
      throw new Error(`Sandbox bootstrap failed: ${result.stderr || result.stdout}`);
    }

    if (process.env.BOT_SANDBOX_PREINSTALL_BROWSER === "0") return;
    try {
      // Bakes agent-browser and Chromium into the template so the first job does
      // not pay for the install.
      await installAgentBrowser(sandbox);
    } catch (error) {
      // Local backends without apt or network still give a working shell; the
      // browser tools install on demand instead.
      console.warn(
        "Could not pre-install agent-browser; it will install on first use.",
        error instanceof Error ? error.message : error,
      );
    }
  },

  async onSession({ use, ctx }) {
    const sandbox = await use();
    const principal = ctx.session.auth.current ?? ctx.session.auth.initiator;
    await sandbox.writeTextFile({
      path: "notes/SESSION.md",
      content: [
        "# Session",
        `session: ${ctx.session.id}`,
        `working for: ${principal?.principalId ?? "unknown"}`,
        "",
        "Scratch space. Nothing here survives the sandbox — use save_artifact for",
        "anything the operator should keep.",
        "",
      ].join("\n"),
    });
  },
});
