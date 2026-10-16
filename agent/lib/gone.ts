import { SessionStrandedError } from "eve/channels";

/**
 * Kept apart from `session.ts`, which workflow code imports: `eve/channels` must
 * stay out of the workflow bundle.
 *
 * A send that failed because the thread's session can never run again: stranded
 * by another eve version, or, under `eve dev`, a run from an earlier dev server
 * that was not resumed. The second crosses eve's worker boundary as a plain
 * error, so it is known by name.
 */
export function sessionIsGone(error: unknown): boolean {
  if (SessionStrandedError.is(error)) return true;
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "DevelopmentRunUnavailableError" || message.startsWith("DevelopmentRunUnavailableError");
}
