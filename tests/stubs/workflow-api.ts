/**
 * `workflow/api` for tests. eve resolves the specifier to its vendored
 * Workflow runtime when it bundles the agent; there is no `workflow` package
 * on disk for vitest to find. Nothing here starts a run, so no hook exists
 * to resume: resuming one answers the way the runtime does for a run that
 * has ended. Tests that need a listening run mock this module.
 */
export async function resumeHook(token: string, _payload: unknown): Promise<never> {
  const error = new Error(`Hook not found: ${token}`);
  error.name = "HookNotFoundError";
  throw error;
}
