// First: the build's Settings values over the environment, before anything below reads it (see settings/built.ts).
import "./settings/built";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { MicrosandboxSandbox } from "eve/sandbox/microsandbox";
import { VercelSandbox } from "eve/sandbox/vercel";

import { Sandbox as VercelMachine } from "@vercel/sandbox";

import { attachDrive, bindDrive, DRIVE_MOUNT, driveHeld, driveMounts, driveWanted, ensureDrive } from "./computer-drive";
import { effectiveEnv, liveEnv } from "./settings/store";
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

type Env = Readonly<Record<string, string | undefined>>;

/** The hosts the computer may reach, from Settings over `BOT_SANDBOX_ALLOW_DOMAINS`; empty is everything. */
export const allowedDomains = (env: Env = liveEnv()): string[] =>
  (env.BOT_SANDBOX_ALLOW_DOMAINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * Egress is open by default because the browser and packages download on first
 * use. Set the allowed sites in production to fence the computer to the hosts
 * it needs — applied at the firewall, outside the sandbox.
 */
export function networkPolicy(env: Env = liveEnv()): SandboxNetworkPolicy {
  const allow = allowedDomains(env);
  return allow.length > 0 ? { allow } : "allow-all";
}

/** The computer's CPUs (2 GB of memory each), 1 to 8, 4 otherwise. */
export function computerVcpus(env: Env = liveEnv()): number {
  const vcpus = Number(env.BOT_SANDBOX_VCPUS?.trim() || 4);
  return Number.isInteger(vcpus) && vcpus >= 1 && vcpus <= 8 ? vcpus : 4;
}

/** How long the Vercel computer runs between uses before it idles out, in ms. */
export function computerTimeoutMs(env: Env = liveEnv()): number {
  const minutes = Number(env.BOT_SANDBOX_TIMEOUT_MINUTES?.trim() || 30);
  return (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 5 * 60) : 30) * 60_000;
}

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
    const options = { prepare, memoryMiB: 2048 * computerVcpus(process.env) };
    const environment =
      image.kind === "dockerfile" ? MicrosandboxSandbox.dockerfile(options) : image.kind === "image" ? MicrosandboxSandbox.image(image.reference, options) : MicrosandboxSandbox.environment(options);
    return TeamComputer.environment({ provider: "microsandbox", environment, check: localModeError });
  }
  // What a new machine is made with; Settings changed since are pushed to it by `reconcile`.
  return TeamComputer.environment({
    provider: "vercel",
    environment: VercelSandbox.environment({
      prepare,
      // A prebuilt image in Vercel Container Registry; without one, eve's base image and the first-boot install.
      ...(image.kind === "image" ? { image: image.reference } : {}),
      networkPolicy: networkPolicy(process.env),
      resources: { vcpus: computerVcpus(process.env) },
      ports: [COMPUTER_PORT],
      timeout: computerTimeoutMs(process.env),
    }),
    check: vercelCredentialsError,
    open: computerOpenOptions(process.env),
    beforeStart: async () => {
      const env = await effectiveEnv().catch(() => process.env);
      if (driveWanted(env)) await ensureDrive(env);
    },
    onMachine: reconcile,
    startAgain: driveHeld,
  });
}

/** Whether two network policies allow the same hosts; Vercel may read a list back as a map of hosts to rules. */
export function sameNetwork(current: unknown, wanted: SandboxNetworkPolicy): boolean {
  const hosts = (policy: unknown): string => {
    if (policy === undefined || policy === null) return "allow-all";
    if (typeof policy === "string") return policy;
    const allow = (policy as { allow?: unknown }).allow;
    const list = Array.isArray(allow) ? allow.map(String) : typeof allow === "object" && allow !== null ? Object.keys(allow) : [];
    return [...list].sort().join(",");
  };
  return hosts(current) === hosts(wanted);
}

/** What was last pushed to each machine, by name, so an unchanged machine costs no call to Vercel. */
const reconciled = new Map<string, { readonly wanted: string; readonly mounted: boolean }>();

/**
 * Every time a session gets the Vercel computer: Settings changed since the
 * machine was made are pushed to it (the allowed sites and how long it stays
 * up apply at once, CPUs and a new drive from its next session), and the work
 * folders are bound from its drive (see `computer-drive.ts`).
 */
export async function reconcile(sandbox: SandboxSession, state: unknown): Promise<void> {
  const name = (state as { sandboxName?: unknown } | null)?.sandboxName;
  if (typeof name !== "string") return;
  const env = await effectiveEnv().catch(() => process.env);
  const wanted = { networkPolicy: networkPolicy(env), vcpus: computerVcpus(env), timeout: computerTimeoutMs(env), drive: driveWanted(env) };
  const key = JSON.stringify(wanted);
  let known = reconciled.get(name);
  if (known?.wanted !== key) {
    const machine = await VercelMachine.get({ name });
    const update: Parameters<typeof machine.update>[0] = {
      ...(sameNetwork(machine.networkPolicy, wanted.networkPolicy) ? {} : { networkPolicy: wanted.networkPolicy }),
      ...(machine.vcpus === wanted.vcpus ? {} : { resources: { vcpus: wanted.vcpus } }),
      ...(machine.timeout === wanted.timeout ? {} : { timeout: wanted.timeout }),
    };
    if (Object.keys(update).length > 0) {
      await machine.update(update);
      console.log(`[computer] ${name}: applied ${Object.keys(update).join(", ")} from Settings.`);
    }
    // A drive is only ever added here: the work on it stays mounted until someone removes it by hand.
    if (wanted.drive && (await attachDrive(name, env))) console.log(`[computer] ${name} will mount its drive from its next start.`);
    known = { wanted: key, mounted: wanted.drive || machine.mounts?.[DRIVE_MOUNT] !== undefined };
    reconciled.set(name, known);
  }
  if (!known.mounted) return;
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
export function computerOpenOptions(env: Env = liveEnv()): object | undefined {
  if (computerMode() !== "local") {
    const mounts = driveMounts(env);
    return mounts === undefined ? undefined : { mounts };
  }
  return localComputer() === "docker" ? { networkPolicy: allowedDomains(env).length > 0 ? "deny-all" : "allow-all" } : { networkPolicy: networkPolicy(env) };
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
