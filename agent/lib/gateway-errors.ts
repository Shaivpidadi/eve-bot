/**
 * AI Gateway's refusals, said plainly. A module with no imports on purpose:
 * `run_job`'s workflow body calls `explainGatewayError`, and everything a
 * workflow body imports is bundled for the workflow, which can't take the
 * store or Node's built-ins (see `models.ts`, which re-exports these).
 */
/**
 * Two AI Gateway refusals worth saying plainly, from an error's message:
 * - `budget`: a Gateway budget (set for the team, project, key or user in the
 *   dashboard) is used up: HTTP 402 `quota_for_entity_exceeded`.
 * - `no-providers`: no provider can serve the model under the data controls
 *   asked for (`BOT_ZDR`, `BOT_INFERENCE_REGION`): a 400 typed
 *   `no_providers_available`, or for ZDR `no_zdr_providers_available` with the
 *   message "No ZDR … providers … available for model: <id>", and for a region
 *   "No provider for <id> supports the requested inference region" (both seen live).
 * - `no-images`: the model takes text only, and the work sent it a screenshot
 *   (the browser works from them): "This model does not support image or file
 *   input" (seen live from free models).
 * Null for anything else, which keeps its own message.
 */
/** A model refusing an image: Gateway's wording, and the usual provider ones. */
export const NO_IMAGES = /\bdoes not support (?:image|file|vision)\b|\bimage (?:or file )?input is not supported\b/i;

export function explainGatewayError(
  message: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly kind: "budget" | "no-providers" | "no-images"; readonly text: string } | null {
  if (/quota_for_entity_exceeded|\b402\b[^]*\bbudget\b/i.test(message)) {
    return {
      kind: "budget",
      text: "Stopped by an AI Gateway budget: the budget set for this team, project or key in the Vercel dashboard (AI Gateway → Budgets) is used up. Raise it there, or wait for it to reset, then run it again.",
    };
  }
  if (/no_[a-z_]*providers_available|\bno\b[^.]*\bproviders\b[^.]*\bavailable\b|\bno provider for\b.*?\bsupports the requested\b/i.test(message)) {
    const model = /\bfor (?:model:\s*)?([\w-]+\/[\w./:-]*[\w-])/i.exec(message)?.[1] ?? null;
    const subject = model === null ? "this model" : model;
    const asked = [
      /^(1|true|on|yes)$/i.test(env.BOT_ZDR?.trim() ?? "") ? "Zero Data Retention (BOT_ZDR)" : null,
      env.BOT_INFERENCE_REGION?.trim() ? `inference in ${env.BOT_INFERENCE_REGION.trim().toUpperCase()} (BOT_INFERENCE_REGION)` : null,
    ].filter((part): part is string => part !== null);
    return {
      kind: "no-providers",
      text:
        asked.length > 0
          ? `No AI Gateway provider can serve ${subject} with ${asked.join(" and ")}. Choose a model that offers it, or turn the setting off.`
          : `No AI Gateway provider can serve ${subject} right now. Choose another model, or try again later.`,
    };
  }
  if (NO_IMAGES.test(message)) {
    return {
      kind: "no-images",
      text: "This model reads text only, and the browser works from screenshots. Choose a model that takes images for Bots on the Models page (marked as seeing images), then run it again.",
    };
  }
  return null;
}
