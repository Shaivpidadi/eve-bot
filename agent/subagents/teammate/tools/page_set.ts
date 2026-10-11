import { defineTool } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { guardSideEffect } from "../../../lib/run-guard";

import { gate } from "../lib/gate";
import { act } from "../lib/page";

/**
 * Dropdowns and checkboxes, which clicking does not reliably set.
 *
 * A `<select>` opened with a click renders its options outside the page's own
 * tree on most platforms, so a bot that clicks one is left guessing; a checkbox
 * clicked twice is back where it started. Both have exact commands, and a bot
 * that says the state it wants gets that state.
 *
 * Checked like a click: ticking "I agree" or choosing a plan is a commitment,
 * and comes back as a proposal for `page_confirm` instead of happening.
 */
export default defineTool({
  description:
    "Set a dropdown or a checkbox, by the state you want rather than by clicking. Give option to choose from a <select> (its visible label or its value), or checked to tick or untick a checkbox or radio. Reports what changed the same way page_click does. A choice that could commit to something (agreeing, subscribing, paying) comes back with needsApproval and a proposal for page_confirm.",
  inputSchema: z
    .object({
      target: z.string().min(1).describe("An @ref like @e9, or a CSS selector."),
      option: z.string().max(400).optional().describe("The option to choose in a <select>: its visible label or value."),
      checked: looseBoolean().optional().describe("True to tick a checkbox or radio, false to untick it."),
    })
    .refine((input) => (input.option === undefined) !== (input.checked === undefined), {
      message: "Give exactly one of option (for a dropdown) or checked (for a checkbox).",
    }),
  label: { start: ({ target, option, checked }) => `Set ${target} to ${option ?? (checked === true ? "checked" : "unchecked")}` },
  async execute({ target, option, checked }, ctx) {
    const kind = option !== undefined ? "select" : checked === true ? "check" : "uncheck";
    const checkedGate = await gate(ctx, {
      kind,
      target: { target },
      action: (selector) => (option !== undefined ? ["select", selector, option] : [kind, selector]),
      ...(option === undefined ? {} : { option }),
    });
    if (!checkedGate.go) return { set: false as const, target, ...checkedGate.result };
    const run = await guardSideEffect(ctx);
    if (!run.ok) return { set: false as const, target, reason: run.reason, error: run.message };
    const result = await act(ctx, checkedGate.action);
    if (!result.ok) {
      return {
        set: false as const,
        target,
        error: result.error,
        detail: result.detail,
        hint:
          option !== undefined
            ? "Check the option's exact wording in the snapshot; a <select> only accepts options it actually has."
            : "Only a checkbox or radio can be ticked. For anything else, use page_click.",
      };
    }
    const { ok: _ok, ...seen } = result;
    return { set: true as const, target, ...(option === undefined ? { checked } : { option }), ...seen };
  },
});
