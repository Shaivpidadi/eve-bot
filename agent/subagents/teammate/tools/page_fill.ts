import { defineTool } from "eve/tools";
import { z } from "zod";

import { looseBoolean } from "../../../lib/tool-input";

import { guardSideEffect } from "../../../lib/run-guard";

import { browser } from "../lib/browser";
import { gate, inspect, staleRef, staleResult } from "../lib/gate";
import { act } from "../lib/page";
import { LOCATORS, missHint, targetArgs } from "../lib/target";

/**
 * Typing is never gated: it changes nothing outside the page. The Enter that
 * `submit` presses is, because it submits whatever form or composer the field
 * belongs to — in a mail or chat app, that is "send". A search box goes
 * straight through; anything else that could submit is typed, then handed
 * back as a proposal for `page_confirm` to press Enter once a person approves.
 */
export default defineTool({
  description:
    "Clear a field and type into it. Name the field with an @ref, a CSS selector, or — with `by` — its label, placeholder, or text. Set submit to press Enter afterwards; unless the field is a search, the Enter waits for a person's approval (the result has needsApproval and a proposal for page_confirm). Reports what changed on the page the same way page_click does. Never pass a password or one-time code you were not explicitly given for this job.",
  inputSchema: z.object({
    target: z.string().min(1).describe("An @ref like @e7, a CSS selector, or what to look for when `by` is set."),
    by: z
      .enum(LOCATORS)
      .optional()
      .describe('How to read target: "ref" (default, also CSS), or "label", "placeholder", "text", "testid", "role".'),
    name: z.string().max(200).optional().describe('With by "role": the accessible name of the field.'),
    value: z.string().max(4_000),
    submit: looseBoolean().optional().describe("Press Enter after filling."),
  }),
  label: {
    // The value can be sensitive, so activity shows the field, never the text.
    start: ({ target }) => `Fill ${target}`,
  },
  async execute({ target, by, name, value, submit }, ctx) {
    const named = { target, ...(by === undefined ? {} : { by }), ...(name === undefined ? {} : { name }) };
    if (submit === true) {
      // Pinned first, the way the gate pins it, so the field typed into is the
      // one whose Enter is checked, not whichever `find` would have picked.
      const pinned = await inspect(ctx, named, { dom: false });
      if (pinned.selector === null) {
        return {
          filled: false as const,
          target,
          error: `Nothing was typed: ${pinned.problem ?? "the field could not be identified"}.`,
          hint: "Take a page_snapshot and name the field by its @ref.",
        };
      }
      // A ref the page renumbered since the Bot read it would put the text, and the Enter, in another field.
      const moved = staleRef(ctx, named, pinned);
      if (moved !== null) return { filled: false as const, target, ...staleResult(moved) };
      const field = pinned.selector;
      const filled = await browser(ctx, ["fill", field, value]);
      if (!filled.ok) return { filled: false as const, target, error: filled.error, detail: filled.output, hint: missHint(named) };
      const checked = await gate(ctx, {
        kind: "submit",
        target: { target: field },
        prepare: (selector) => [["focus", selector]],
        action: () => ["press", "Enter"],
        value,
        // Typing can re-render the page; the Enter goes only to the field just typed into.
        ...(pinned.element.tree === null ? {} : { expect: pinned.element.tree }),
      });
      if (!checked.go) return { filled: true as const, submitted: false as const, target, ...checked.result };
      const run = await guardSideEffect(ctx);
      if (!run.ok) return { filled: true as const, submitted: false as const, target, reason: run.reason, error: run.message };
      for (const step of checked.prepare) await browser(ctx, step);
      const pressed = await act(ctx, checked.action);
      if (!pressed.ok) return { filled: true as const, submitted: false as const, target, error: pressed.error, detail: pressed.detail };
      const { ok: _ok, ...seen } = pressed;
      return { filled: true as const, submitted: true as const, target, ...seen };
    }
    const result = await act(ctx, targetArgs(named, "fill", value));
    if (!result.ok) return { filled: false as const, target, error: result.error, detail: result.detail, hint: missHint(named) };
    const { ok: _ok, ...seen } = result;
    return { filled: true as const, submitted: false as const, target, ...seen };
  },
});
