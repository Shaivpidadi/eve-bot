/**
 * Memory: what the team remembers across sessions, and how it gets there.
 *
 * - `store.ts`: the records, per workspace and slot, with where each came from.
 * - `rank.ts`: which entries a turn sees.
 * - `capture.ts`: remembering unprompted, with Jev as the gatekeeper.
 * - `provider.ts`: the eve memory provider that ties them together.
 */
export { capture, cues, defaultDeps, memoryFloor, modelExtract } from "./capture";
export type { CaptureDeps, CaptureInput, CaptureMode, CaptureResult, Extract, Judge, Proposal } from "./capture";
export { memoryCaptureHook } from "./hook";
export { byWorkspace, jobOf, namespaceFor, textOf, trace, workspaceMemory } from "./provider";
export { nearest, select, tokens } from "./rank";
export {
  acceptable,
  forget,
  isMemoryKind,
  isMemorySlot,
  looksSecret,
  MEMORY_SLOTS,
  normalize,
  noteRecalled,
  pin,
  readEntries,
  readMemoryDoc,
  remember,
  rewrite,
  SLOTS,
} from "./store";
export type { MemoryCandidate, MemoryDoc, MemoryEntry, MemoryKind, MemorySlot, MemorySource, RememberOutcome } from "./store";
