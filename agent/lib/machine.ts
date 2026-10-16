import type { SandboxPreparedArtifact } from "eve/sandbox/provider";

import { COMPUTER_NAME } from "./computer";

/**
 * The team computer's machine record: which native machine the shared computer
 * is (see `team-computer.ts`). Kept apart from the provider so code that only
 * needs the machine's name, such as the console's controls and the runtime
 * charge, never pulls eve's sandbox providers in with it; workflow code reaches
 * some of it.
 */
export type ComputerProviderName = "vercel" | "docker" | "microsandbox";

export interface MachineRecord {
  readonly provider: ComputerProviderName;
  /** The built-in provider's own state for the machine: what it needs to reconnect. */
  readonly state: SandboxPreparedArtifact;
  readonly at: string;
}

const RECORD_KEY = `computer/${COMPUTER_NAME}/machine.json`;

export async function readMachineRecord(): Promise<MachineRecord | null> {
  const { readDoc } = await import("./store");
  return (await readDoc<MachineRecord>(RECORD_KEY))?.value ?? null;
}

export async function writeMachineRecord(record: MachineRecord): Promise<void> {
  const { writeDoc } = await import("./store");
  await writeDoc(RECORD_KEY, record);
}

/**
 * The machine's native name, for code that reaches it without eve: the recorded
 * Vercel Sandbox (eve names the ones it makes `eve-sbx-vercel-…`) or Docker
 * container (`eve-sbx-…`), or the computer's own name for a machine from before
 * this record existed (which the Vercel provider adopts).
 */
export async function machineName(): Promise<string> {
  const record = await readMachineRecord().catch(() => null);
  const state = (record?.state ?? null) as { sandboxName?: unknown; containerName?: unknown; name?: unknown } | null;
  const name = state?.sandboxName ?? state?.containerName ?? state?.name;
  return typeof name === "string" && name !== "" ? name : COMPUTER_NAME;
}
