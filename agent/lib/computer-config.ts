import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SandboxBackend, SandboxNetworkPolicy } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { microsandbox } from "eve/sandbox/microsandbox";
import { vercel } from "eve/sandbox/vercel";

import { sharedComputer } from "./computer";

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

/** An expired snapshot is a computer that comes back empty. */
const NO_EXPIRY = 0;

/** Why the Vercel computer cannot start here, or null when it can. */
export function vercelCredentialsError(): string | null {
  if (process.env.VERCEL === "1") return null;
  const env = (name: string) => (process.env[name] ?? "").trim() !== "";
  if (env("VERCEL_OIDC_TOKEN")) return null;
  if (env("VERCEL_TOKEN") && (env("VERCEL_TEAM_ID") || env("VERCEL_ORG_ID")) && env("VERCEL_PROJECT_ID")) return null;
  if (existsSync(join(process.cwd(), ".vercel", "project.json"))) return null;
  return 'The team\'s computer runs on Vercel Sandbox. Run "vercel link && vercel env pull" in the project, or set BOT_COMPUTER=local to use a VM on this machine.';
}

export function computerBackend(): SandboxBackend {
  if (computerMode() === "local") {
    const local =
      localComputer() === "docker"
        ? docker({ networkPolicy: allow.length > 0 ? "deny-all" : "allow-all" })
        : microsandbox({
            memoryMiB: 2048 * Number(process.env.BOT_SANDBOX_VCPUS ?? 4),
            networkPolicy,
          });
    return sharedComputer(guarded(local, localModeError));
  }

  const minutes = Number(process.env.BOT_SANDBOX_TIMEOUT_MINUTES ?? 30);
  return sharedComputer(
    guarded(
      vercel({
        networkPolicy,
        resources: { vcpus: Number(process.env.BOT_SANDBOX_VCPUS ?? 4) },
        snapshotExpiration: NO_EXPIRY,
        keepLastSnapshots: { count: 3, expiration: NO_EXPIRY },
        ports: [COMPUTER_PORT],
        timeout: minutes * 60_000,
      }),
      vercelCredentialsError,
    ),
  );
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

/** Fails a session start with a plain explanation instead of a provider stack trace. */
function guarded<BO, SO>(inner: SandboxBackend<BO, SO>, check: () => string | null): SandboxBackend<BO, SO> {
  return {
    name: inner.name,
    prewarm: (input) => inner.prewarm(input),
    async create(input) {
      const problem = check();
      if (problem !== null) throw new Error(problem);
      return inner.create(input);
    },
  };
}
