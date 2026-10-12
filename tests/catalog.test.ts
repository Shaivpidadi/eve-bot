import { describe, expect, it } from "vitest";

import { CATALOG, catalogEntry, classifyTool, classifyTools, effectOf, isReviewedRead, isWriteTool, mergePolicy, toolEffect } from "../agent/lib/catalog";

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
    for (const name of ["get_issue", "list_pull_requests", "search_code", "get_file_contents", "read_wiki_structure", "get-library-docs", "describeTable", "get_pull_request", "list_merge_requests"]) {
      expect(isWriteTool(name), name).toBe(false);
    }
  });

  it("counts any name it does not recognise as a read verb as a change", () => {
    // Unfamiliar verbs, nouns first, and made-up names all need approval.
    for (const name of ["ask_question", "resolve-library-id", "runs_list", "obliterate_everything", "issues", "sync", "github__do_thing"]) {
      expect(classifyTool(name), name).toBe("write");
    }
  });

  it("counts general-purpose tools as changes whatever verb they start with", () => {
    for (const name of ["get_query_result", "fetch_url", "list_sql", "searchViaHttp", "get_shell", "read_exec_output", "find_and_run", "query", "execute_sql", "run_query", "request"]) {
      expect(classifyTool(name), name).toBe("write");
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
    const merged = mergePolicy(corrected, ["run_workflow", "get_issue", "delete_repo"], ["run_workflow"]);
    expect(merged.run_workflow).toBe("read");
    expect(merged.delete_repo).toBe("write");
  });

  it("re-guesses an unreviewed read on a recheck, but never loosens a recorded write", () => {
    // What an older classifier stored: every unfamiliar name as a read.
    const legacy = { mystery_tool: "read", get_issue: "write" } as const;
    const merged = mergePolicy(legacy, ["mystery_tool", "get_issue"]);
    expect(merged.mystery_tool).toBe("write");
    expect(merged.get_issue).toBe("write");
  });

  it("forgets a tool the server no longer offers", () => {
    const merged = mergePolicy(classifyTools(["gone_tool"]), ["get_issue"]);
    expect(merged.gone_tool).toBeUndefined();
  });
});

describe("toolEffect and review", () => {
  it("does not trust a legacy auto read the current classifier would not make", () => {
    const legacy = { policy: { mystery_tool: "read", get_issue: "read" } as const };
    expect(toolEffect(legacy, "mystery_tool")).toEqual({ effect: "write", reviewed: false });
    expect(toolEffect(legacy, "x__get_issue")).toEqual({ effect: "read", reviewed: false });
    expect(toolEffect(legacy, "never_listed")).toEqual({ effect: "write", reviewed: false });
  });

  it("treats an operator's decision as final either way", () => {
    const source = { policy: { mystery_tool: "read", get_issue: "write" } as const, reviewed: ["mystery_tool", "get_issue"] };
    expect(toolEffect(source, "mystery_tool")).toEqual({ effect: "read", reviewed: true });
    expect(toolEffect(source, "get_issue")).toEqual({ effect: "write", reviewed: true });
  });

  it("only counts reviewed reads (or the catalog's) as safe for HQ", () => {
    const guessed = { policy: classifyTools(["get_issue", "create_issue"]) };
    expect(isReviewedRead(guessed, "get_issue")).toBe(false);
    expect(isReviewedRead({ ...guessed, reviewed: ["get_issue"] }, "get_issue")).toBe(true);
    expect(isReviewedRead({ ...guessed, reviewed: ["create_issue"] }, "create_issue")).toBe(false);
    // The catalog vouches for its own reads, even ones the classifier would not guess.
    expect(isReviewedRead({ catalog: "deepwiki", policy: classifyTools(["ask_question"]) }, "ask_question")).toBe(true);
    expect(isReviewedRead({ catalog: "github", policy: classifyTools(["get_me"]) }, "github__get_me")).toBe(true);
    // An operator who marks a catalog read as a change wins.
    expect(isReviewedRead({ catalog: "github", policy: { get_me: "write" }, reviewed: ["get_me"] }, "get_me")).toBe(false);
  });
});
