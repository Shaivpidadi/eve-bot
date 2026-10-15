/**
 * Where eve's Workflow state lives, as far as a lease needs to know.
 *
 * On Vercel every deployment keeps its own runs alive, so a run from another
 * build is still a run. Everywhere else the local world runs one build at a
 * time (eve's own rule from 0.76 on, and what the dev world's quarantine
 * amounts to before that), so a lease held by another build is held by
 * nobody. A shared world named in `BOT_WORKFLOW_WORLD` (a Postgres world,
 * say) is treated like Vercel: a run may outlive the process that started it.
 */
export function worldIsLocal(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.VERCEL === "1") return false;
  return (env.BOT_WORKFLOW_WORLD ?? "").trim() === "";
}
