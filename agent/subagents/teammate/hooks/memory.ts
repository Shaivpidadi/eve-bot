import { defineHook } from "eve/hooks";

import { memoryCaptureHook } from "../../../lib/memory/hook";

/**
 * Learns from each job's transcript once its turn is over: durable lessons
 * about the operator's systems land in the shared `craft` memory, with Jev
 * deciding what counts as a lesson rather than a record of this one job.
 */
export default defineHook(memoryCaptureHook("job"));
