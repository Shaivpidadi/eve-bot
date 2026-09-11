import { z } from "zod";

/**
 * A boolean tool input as models actually send it.
 *
 * Smaller models often write booleans as strings ("true", "false"). A strict
 * schema rejects the call, and the retry tends to drop the field rather than
 * fix it. The model still sees a plain boolean in the tool's JSON schema. For
 * numbers, use `z.coerce.number()`, which behaves the same way.
 */
export const looseBoolean = () =>
  z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean());
