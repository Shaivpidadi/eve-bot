/**
 * Memory: what the team remembers across sessions, and how it gets there.
 *
 * - `store.ts`: the records, per workspace and slot, with where each came from.
 * - `rank.ts`: which entries a turn sees.
 * - `capture.ts`: remembering unprompted, with Jev as the gatekeeper.
 * - `provider.ts`: the eve memory provider that ties them together.
 */
export { capture, cues, defaultDeps, existingFor, memoryFloor, modelExtract, slotsFor } from "./capture";
export type { CaptureDeps, CaptureInput, CaptureMode, CaptureResult, Existing, Extract, Fields, Judge, Proposal } from "./capture";
export { memoryCaptureHook } from "./hook";
export { learnFromDenial, learnFromFeedback } from "./outcomes";
export { byWorkspace, jobOf, namespaceFor, textOf, trace, workspaceMemory } from "./provider";
export { nearest, select, tokens } from "./rank";
export {
  acceptable,
  applyOperations,
  fieldFor,
  FIELDS,
  forget,
  isMemoryKind,
  isMemorySlot,
  liveEntries,
  looksSecret,
  MEMORY_SLOTS,
  normalize,
  noteRecalled,
  pin,
  readEntries,
  readFields,
  readForgotten,
  readMemoryDoc,
  remember,
  resolveField,
  restore,
  rewrite,
  setField,
  SLOTS,
} from "./store";
export type { ApplyOutcome, FieldChange, MemoryCandidate, MemoryDoc, MemoryEntry, MemoryField, MemoryFieldValue, MemoryKind, MemoryOperation, MemoryRevision, MemorySlot, MemorySource, RememberOutcome } from "./store";
