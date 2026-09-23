import { describe, expect, it } from "vitest";

import { CATALOG, catalogEntry, classifyTools, effectOf, isWriteTool, mergePolicy } from "../agent/lib/catalog";

describe("the connector catalog", () => {
  it("has distinct ids, https addresses, and a key hint wherever a key is needed", () => {
    expect(new Set(CATALOG.map((entry) => entry.id)).size).toBe(CATALOG.length);
    for (const entry of CATALOG) {
      expect(entry.url.startsWith("https://")).toBe(true);
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);
      if (entry.key.kind !== "none" && entry.key.kind !== "oauth") expect(entry.keyHelp).toBeTruthy();
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

describe("recorded tool policy", () => {
  it("classifies a server's tools once, by their verbs", () => {
    expect(classifyTools(["get_issue", "create_issue", "search_code"])).toEqual({
      get_issue: "read",
      create_issue: "write",
      search_code: "read",
    });
  });

  it("treats a tool nobody classified as a write", () => {
    const policy = classifyTools(["get_issue"]);
    expect(effectOf(policy, "get_issue")).toBe("read");
    // The server grew a tool since it was connected.
    expect(effectOf(policy, "obliterate_everything")).toBe("write");
    expect(effectOf(undefined, "get_issue")).toBe("write");
  });

  it("matches a namespaced call against the bare tool name", () => {
    expect(effectOf(classifyTools(["get_issue"]), "github__get_issue")).toBe("read");
  });

  it("keeps an operator's correction across a recheck, and classifies what is new", () => {
    const corrected = { ...classifyTools(["run_workflow", "get_issue"]), run_workflow: "read" as const };
    const merged = mergePolicy(corrected, ["run_workflow", "get_issue", "delete_repo"]);
    expect(merged.run_workflow).toBe("read");
    expect(merged.delete_repo).toBe("write");
  });

  it("forgets a tool the server no longer offers", () => {
    const merged = mergePolicy(classifyTools(["gone_tool"]), ["get_issue"]);
    expect(merged.gone_tool).toBeUndefined();
  });
});
