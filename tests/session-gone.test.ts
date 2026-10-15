import { SessionStrandedError } from "eve/channels";
import { describe, expect, it } from "vitest";

import { sessionIsGone } from "../agent/lib/session";

/** Which send failures move a thread to a fresh session instead of failing the person's message. */
describe("sessionIsGone", () => {
  it("knows a stranded session and a dev run that was not resumed", () => {
    expect(sessionIsGone(new SessionStrandedError({ eveVersion: "0.58.1" }))).toBe(true);
    // Crosses eve's worker boundary as a plain error, so only its name survives.
    expect(sessionIsGone(Object.assign(new Error("Local Workflow run was not resumed."), { name: "DevelopmentRunUnavailableError" }))).toBe(true);
    expect(sessionIsGone(new Error("DevelopmentRunUnavailableError: Local Workflow run was not resumed."))).toBe(true);
  });

  it("leaves every other failure alone", () => {
    expect(sessionIsGone(new Error("fetch failed"))).toBe(false);
    expect(sessionIsGone(null)).toBe(false);
    expect(sessionIsGone("DevelopmentRunUnavailable")).toBe(false);
  });
});
