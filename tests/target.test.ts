import { describe, expect, it } from "vitest";

import { missHint, targetArgs } from "../agent/subagents/teammate/lib/target";

describe("targetArgs", () => {
  it("acts on a ref or selector directly", () => {
    expect(targetArgs({ target: "@e12" }, "click")).toEqual(["click", "@e12"]);
    expect(targetArgs({ target: "#send", by: "ref" }, "click")).toEqual(["click", "#send"]);
    expect(targetArgs({ target: "@e7" }, "fill", "hello")).toEqual(["fill", "@e7", "hello"]);
  });

  it("looks an element up when it is named instead of referenced", () => {
    expect(targetArgs({ target: "Send", by: "text" }, "click")).toEqual(["find", "text", "Send", "click"]);
    expect(targetArgs({ target: "Email", by: "label" }, "fill", "a@b.example")).toEqual([
      "find",
      "label",
      "Email",
      "fill",
      "a@b.example",
    ]);
  });

  it("passes an accessible name only with a role", () => {
    expect(targetArgs({ target: "button", by: "role", name: "Send" }, "click")).toEqual([
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Send",
    ]);
    expect(targetArgs({ target: "Send", by: "text", name: "ignored" }, "click")).toEqual(["find", "text", "Send", "click"]);
  });
});

describe("missHint", () => {
  it("blames the ref for a ref, and the wording for a lookup", () => {
    expect(missHint({ target: "@e1" })).toMatch(/stale ref/);
    expect(missHint({ target: "Send", by: "text" })).toMatch(/Nothing on the page matched text "Send"/);
  });
});
