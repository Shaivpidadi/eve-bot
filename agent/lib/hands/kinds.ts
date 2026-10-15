import { computerMode, localComputer } from "../computer-config";

/**
 * Which kind of machine the team's computer is, and what it can do.
 *
 * The app adapts to the machine through these flags, not through its name:
 * a machine without a browser refuses the browser tools in plain words, and
 * a backup restores only onto the kind it was taken on. Every kind today is
 * the Linux computer on a different host, so every flag is on; a machine
 * that only runs commands (see D3.3 in the plan) turns `screen`, `browser`
 * and `handover` off.
 */
export type HandsKindName = "vercel-linux" | "docker-linux" | "microsandbox-linux";

export interface Capabilities {
  /** A display the console can watch and capture. */
  readonly screen: boolean;
  /** Google Chrome, driven over DevTools. */
  readonly browser: boolean;
  /** A person can take over the screen for a step. */
  readonly handover: boolean;
  /** A shell the Bots may use. */
  readonly shell: boolean;
}

export interface HandsKind {
  readonly name: HandsKindName;
  /** For people: where the computer runs. */
  readonly label: string;
  readonly capabilities: Capabilities;
}

const FULL: Capabilities = { screen: true, browser: true, handover: true, shell: true };

export const KINDS: Readonly<Record<HandsKindName, HandsKind>> = {
  "vercel-linux": { name: "vercel-linux", label: "Vercel Sandbox", capabilities: FULL },
  "docker-linux": { name: "docker-linux", label: "Docker on this machine", capabilities: FULL },
  "microsandbox-linux": { name: "microsandbox-linux", label: "a VM on this machine", capabilities: FULL },
};

/** The kind the configuration selects (`BOT_COMPUTER`, `BOT_COMPUTER_LOCAL`). */
export function currentKind(): HandsKind {
  if (computerMode() === "vercel") return KINDS["vercel-linux"];
  return localComputer() === "microsandbox" ? KINDS["microsandbox-linux"] : KINDS["docker-linux"];
}

/** A plain refusal when the computer cannot do what a tool needs, or null when it can. */
export function lacking(kind: HandsKind, capability: keyof Capabilities): string | null {
  if (kind.capabilities[capability]) return null;
  const what = { screen: "a screen", browser: "a web browser", handover: "a screen a person can take over", shell: "a shell" }[capability];
  return `The team's computer (${kind.label}) has no ${what.replace(/^an? /, "")}. Do this another way, or tell the operator it needs a computer with ${what}.`;
}

/** One line for a brief: where the Bot works and what it has there. */
export function describeKind(kind: HandsKind): string {
  const has = (Object.keys(kind.capabilities) as (keyof Capabilities)[]).filter((key) => kind.capabilities[key]);
  return `computer: ${kind.label} (${has.join(", ")})`;
}
