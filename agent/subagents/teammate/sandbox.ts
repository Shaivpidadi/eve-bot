import { defineSandbox } from "eve/sandbox";

/**
 * A teammate works on the team's one computer: the sandbox of the conversation
 * that started its job, which is itself the shared computer (see
 * `agent/sandbox/sandbox.ts`).
 */
export default defineSandbox(({ parent }) => {
  if (parent === null) {
    throw new Error("A teammate runs as part of a job; it has no computer of its own.");
  }
  return parent.sandbox;
});
