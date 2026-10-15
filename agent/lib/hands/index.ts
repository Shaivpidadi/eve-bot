import type { ToolContext } from "eve/tools";

import { sandboxIo, toolIo, type ComputerIo } from "../computer/runtime";
import { linuxHands } from "./linux";
import type { Hands } from "./types";

export type { Hands, HandsKindId } from "./types";
export { currentKind, describeKind, KINDS, lacking, type Capabilities, type HandsKind, type HandsKindName } from "./kinds";
export { ComputerError, isInstalling, MAX_FILE_BYTES, shellQuote, type ComputerIo, type InputEvent } from "../computer/runtime";

/**
 * The hands on the machine `io` reaches. One kind today; a second kind of
 * machine is picked here (see `docs/plan/durable-runs.md`, D3).
 */
export function handsFor(io: ComputerIo): Hands {
  return linuxHands(io);
}

/** The hands a Bot's tool works with: its session's computer. */
export async function toolHands(ctx: ToolContext): Promise<Hands> {
  return handsFor(await toolIo(ctx));
}

/** The hands on a sandbox handle eve gave us directly (a template's bootstrap, a backup). */
export function sandboxHands(sandbox: Parameters<typeof sandboxIo>[0], abortSignal?: AbortSignal): Hands {
  return handsFor(sandboxIo(sandbox, abortSignal));
}
