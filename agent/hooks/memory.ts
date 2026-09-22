import { defineHook } from "eve/hooks";

import { memoryCaptureHook } from "../lib/memory/hook";

/**
 * Remembers what the operator says to HQ that will still matter next month,
 * without being asked: preferences, facts about them and their team, standing
 * rules. Jev decides what qualifies; see `lib/memory/capture.ts`.
 */
export default defineHook(memoryCaptureHook("conversation"));
