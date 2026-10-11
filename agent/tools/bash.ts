/**
 * eve's `bash`, run as the computer's unprivileged `bot` user so a command can
 * never reach the team's browser around its approval gate (see `lib/computer/shell.ts`).
 */
export { isolatedBash as default } from "../lib/computer/shell";
