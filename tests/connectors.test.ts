import { describe, expect, it } from "vitest";

import { allowedTools } from "../agent/lib/connectors";

const connector = {
  check: { ok: true, at: "2026-09-21T12:00:00.000Z", tools: ["get_me", "list_issues", "create_issue", "merge_pull_request"], error: null },
  policy: { get_me: "read", list_issues: "read", create_issue: "write", merge_pull_request: "write" } as const,
};

/** Which of a connector's tools a Bot, or HQ, is offered. */
describe("allowedTools", () => {
  it("offers everything the server listed until the operator switches something off", () => {
    expect(allowedTools(connector)).toEqual(connector.check.tools);
    expect(allowedTools({ ...connector, disabledTools: ["merge_pull_request"] })).toEqual(["get_me", "list_issues", "create_issue"]);
  });

  it("gives HQ only the reads, and none of the switched-off ones", () => {
    expect(allowedTools(connector, { readsOnly: true })).toEqual(["get_me", "list_issues"]);
    expect(allowedTools({ ...connector, disabledTools: ["list_issues"] }, { readsOnly: true })).toEqual(["get_me"]);
    // A tool nobody classified counts as a change, so HQ never sees it.
    expect(allowedTools({ ...connector, check: { ...connector.check, tools: [...connector.check.tools, "mystery"] } }, { readsOnly: true })).toEqual(["get_me", "list_issues"]);
  });
});
