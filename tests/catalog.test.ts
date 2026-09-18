import { describe, expect, it } from "vitest";

import { CATALOG, catalogEntry, isWriteTool } from "../agent/lib/catalog";

describe("the connector catalog", () => {
  it("has distinct ids, https addresses, and a key hint wherever a key is needed", () => {
    expect(new Set(CATALOG.map((entry) => entry.id)).size).toBe(CATALOG.length);
    for (const entry of CATALOG) {
      expect(entry.url.startsWith("https://")).toBe(true);
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
      if (entry.key.kind !== "none") expect(entry.keyHelp).toBeTruthy();
    }
    expect(catalogEntry("github")?.gate).toBe("writes");
    expect(catalogEntry("nope")).toBeUndefined();
  });
});

describe("isWriteTool", () => {
  it("tells tools that change something from tools that read, by the verb in the name", () => {
    for (const name of ["create_issue", "merge_pull_request", "push_files", "delete_file", "add_issue_comment", "update_pull_request_branch", "github__create_branch", "assignCopilotToIssue", "dismiss_notification", "run_workflow"]) {
      expect(isWriteTool(name), name).toBe(true);
    }
    for (const name of ["get_issue", "list_pull_requests", "search_code", "get_file_contents", "read_wiki_structure", "ask_question", "resolve-library-id", "runs_list"]) {
      expect(isWriteTool(name), name).toBe(false);
    }
  });
});
