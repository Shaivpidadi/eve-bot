import type { DynamicModelContext } from "eve";

/**
 * Once per turn, the way `turn.started` resolved capabilities before eve 0.84:
 * eve evaluates a dynamic value before every model call, so a lookup in the
 * store is kept for the turn and made again on the next one. A connector added
 * or a style changed lands at the next message, as it always did.
 */
export const perTurn = <T>(ctx: Pick<DynamicModelContext, "memo" | "turn">, fn: () => Promise<T>): Promise<T> =>
  ctx.memo(["turn", ctx.turn?.id ?? null], fn);
