import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { TeamComputer } from "./team-computer";

/**
 * Where the team's computer runs.
 *
 * `BOT_COMPUTER=vercel` (the default) runs it on Vercel Sandbox, exactly as a
 * Vercel deployment does. `BOT_COMPUTER=local` runs it on this machine, for a
 * standalone deployment or for working locally; it is pinned to one backend so
 * a Docker daemon starting up can never silently swap the computer out.
 */
export type ComputerMode = "vercel" | "local";

export const computerMode = (): ComputerMode => (process.env.BOT_COMPUTER === "local" ? "local" : "vercel");

/**
 * Which local backend runs the computer: Docker by default, which the console
 * can watch live, or a microsandbox VM with `BOT_COMPUTER_LOCAL=microsandbox`
 * (`vm` also works).
 */
export const localComputer = (): "docker" | "microsandbox" =>
  process.env.BOT_COMPUTER_LOCAL === "microsandbox" || process.env.BOT_COMPUTER_LOCAL === "vm" ? "microsandbox" : "docker";

/** The only port the computer exposes: websockify, which checks every token. */
export const COMPUTER_PORT = 6080;

/**
 * agent-browser drives the computer's own Google Chrome over DevTools, so it
 * needs neither its bundled Chromium (which has no Linux ARM64 build) nor that
 * browser's system libraries.
 */
export const AGENT_BROWSER_INSTALL = { installBrowser: false, installSystemDependencies: false } as const;

const allow = (process.env.BOT_SANDBOX_ALLOW_DOMAINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

/**
 * Egress is open by default because the browser and packages download on first
 * use. Set BOT_SANDBOX_ALLOW_DOMAINS in production to fence the computer to the
 * hosts it needs — applied at the firewall, outside the sandbox.
 */
const networkPolicy: SandboxNetworkPolicy = allow.length > 0 ? { allow } : "allow-all";

/** Why the Vercel computer cannot start here, or null when it can. */
export function vercelCredentialsError(): string | null {
  if (process.env.VERCEL === "1") return null;
  const env = (name: string) => (process.env[name] ?? "").trim() !== "";
  if (env("VERCEL_OIDC_TOKEN")) return null;
  if (env("VERCEL_TOKEN") && (env("VERCEL_TEAM_ID") || env("VERCEL_ORG_ID")) && env("VERCEL_PROJECT_ID")) return null;
  if (existsSync(join(process.cwd(), ".vercel", "project.json"))) return null;
  return 'The team\'s computer runs on Vercel Sandbox. Run "vercel link && vercel env pull" in the project, or set BOT_COMPUTER=local to use a VM on this machine.';
}

/**
 * The team's computer as an eve sandbox environment: one machine every session
 * shares (see `team-computer.ts`), made by the built-in provider for this mode.
 * `prepare` runs once per environment generation and is baked into the
 * snapshot or image every new machine starts from.
 */
export function computerEnvironment(prepare: (sandbox: SandboxSession) => Promise<void>) {
  if (computerMode() === "local") {
    return localComputer() === "docker"
      ? TeamComputer.environment({ provider: "docker", environment: DockerSandbox.environment({ prepare }), check: localModeError })
      : TeamComputer.environment({
          provider: "microsandbox",
          environment: MicrosandboxSandbox.environment({ prepare, memoryMiB: 2048 * Number(process.env.BOT_SANDBOX_VCPUS ?? 4) }),
          check: localModeError,
        });
  }
  const minutes = Number(process.env.BOT_SANDBOX_TIMEOUT_MINUTES ?? 30);
  return TeamComputer.environment({
    provider: "vercel",
    environment: VercelSandbox.environment({
      prepare,
      networkPolicy,
      resources: { vcpus: Number(process.env.BOT_SANDBOX_VCPUS ?? 4) },
      ports: [COMPUTER_PORT],
      timeout: minutes * 60_000,
    }),
    check: vercelCredentialsError,
  });
}

/** Options the machine is opened with: local providers take their network policy here. */
export function computerOpenOptions(): object | undefined {
  if (computerMode() !== "local") return undefined;
  return localComputer() === "docker" ? { networkPolicy: allow.length > 0 ? "deny-all" : "allow-all" } : { networkPolicy };
}

/**
 * Docker is the standalone computer: eve keeps its container running between
 * turns, stops it only when the server shuts down, and reattaches on the next
 * start. A microsandbox VM is for trying things out; the console cannot open
 * one, so a production server refuses it rather than run Bots nobody can watch.
 */
function localModeError(): string | null {
  return process.env.NODE_ENV === "production" && localComputer() === "microsandbox"
    ? "BOT_COMPUTER_LOCAL=microsandbox is for development only. Unset it to run the computer in Docker."
    : null;
}
