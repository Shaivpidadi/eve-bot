import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { attachDrive, bindDrive, driveHeld, driveMounts, driveWanted, ensureDrive } from "./computer-drive";
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
  const image = computerImage();
  if (computerMode() === "local") {
    if (localComputer() === "docker") {
      const options = { prepare };
      const environment = image.kind === "dockerfile" ? DockerSandbox.dockerfile(options) : image.kind === "image" ? DockerSandbox.image(image.reference, options) : DockerSandbox.environment(options);
      return TeamComputer.environment({ provider: "docker", environment, check: localModeError });
    }
    const options = { prepare, memoryMiB: 2048 * Number(process.env.BOT_SANDBOX_VCPUS ?? 4) };
    const environment =
      image.kind === "dockerfile" ? MicrosandboxSandbox.dockerfile(options) : image.kind === "image" ? MicrosandboxSandbox.image(image.reference, options) : MicrosandboxSandbox.environment(options);
    return TeamComputer.environment({ provider: "microsandbox", environment, check: localModeError });
  }
  const minutes = Number(process.env.BOT_SANDBOX_TIMEOUT_MINUTES ?? 30);
  return TeamComputer.environment({
    provider: "vercel",
    environment: VercelSandbox.environment({
      prepare,
      // A prebuilt image in Vercel Container Registry; without one, eve's base image and the first-boot install.
      ...(image.kind === "image" ? { image: image.reference } : {}),
      networkPolicy,
      resources: { vcpus: Number(process.env.BOT_SANDBOX_VCPUS ?? 4) },
      ports: [COMPUTER_PORT],
      timeout: minutes * 60_000,
    }),
    check: vercelCredentialsError,
    ...(driveWanted() ? { open: computerOpenOptions(), beforeStart: ensureDrive, onMachine: onDriveMachine, startAgain: driveHeld } : {}),
  });
}

/** Machines named here already carry the drive (or were asked to from their next start). */
const attached = new Set<string>();

/**
 * Every time a session gets the Vercel computer with a drive: a machine from
 * before the drive is given it (it mounts from its next start), and the work
 * folders are bound from it (see `computer-drive.ts`).
 */
async function onDriveMachine(sandbox: SandboxSession, state: unknown): Promise<void> {
  const name = (state as { sandboxName?: unknown } | null)?.sandboxName;
  if (typeof name === "string" && !attached.has(name)) {
    if (await attachDrive(name)) console.log(`[computer] ${name} will mount its drive from its next start.`);
    attached.add(name);
  }
  const { sandboxIo } = await import("./computer/runtime");
  await bindDrive(sandboxIo(sandbox));
}

/**
 * Where the computer's software comes from (see agent/sandbox/Dockerfile).
 *
 * - Locally, by default, eve builds `agent/sandbox/Dockerfile` for this
 *   machine: Chrome, the desktop and agent-browser come with the image.
 * - `BOT_COMPUTER_IMAGE=<reference>` uses an image already built: a Vercel
 *   Container Registry reference on Vercel (linux/amd64), any OCI image locally.
 * - `BOT_COMPUTER_IMAGE=default` (and, on Vercel, leaving it unset) starts from
 *   eve's own base image, and the computer installs its software when it first
 *   boots, as before.
 *
 * Either way the computer's installer checks the software on every machine
 * and adds whatever is missing, so an image only makes the first start fast.
 */
export function computerImage(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly kind: "dockerfile" } | { readonly kind: "image"; readonly reference: string } | { readonly kind: "default" } {
  const named = env.BOT_COMPUTER_IMAGE?.trim() ?? "";
  if (named === "default") return { kind: "default" };
  if (named !== "") return { kind: "image", reference: named };
  return env.BOT_COMPUTER === "local" ? { kind: "dockerfile" } : { kind: "default" };
}

/** Options the machine is opened with: local providers take their network policy here, and a Vercel computer its drive. */
export function computerOpenOptions(): object | undefined {
  if (computerMode() !== "local") {
    const mounts = driveMounts();
    return mounts === undefined ? undefined : { mounts };
  }
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
