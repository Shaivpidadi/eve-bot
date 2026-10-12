import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NETGUARD_JS, parseGuardAnswer } from "../agent/lib/computer/netguard";

/**
 * The network guard's rules, run as the program the computer runs: what a
 * click may send on, what is dropped quietly, and what turns the click into
 * a proposal. Its DevTools side is exercised against a real Chrome on a
 * computer, not here.
 */

const dir = mkdtempSync(join(tmpdir(), "netguard-"));
const program = join(dir, "bot-computer-netguard.mjs");
writeFileSync(program, NETGUARD_JS);

type Request = { method: string; url: string; resourceType?: string; mainFrame?: boolean };

function judge(requests: Request[], state: Record<string, unknown> = {}): { verdicts: string[]; state: Record<string, unknown> } {
  const out = execFileSync(process.execPath, [program, "judge", JSON.stringify(requests), JSON.stringify(state)], { encoding: "utf8" });
  const answer = parseGuardAnswer<{ verdicts: string[]; state: Record<string, unknown> }>(out);
  if (!answer.ok) throw new Error(answer.error);
  return answer;
}

describe("the network guard", () => {
  it("is a program node accepts", () => {
    execFileSync(process.execPath, ["--check", program]);
  });

  it("lets reads go and stops anything that would change something", () => {
    const { verdicts } = judge([
      { method: "GET", url: "https://shop.example.com/api/cart", resourceType: "Fetch" },
      { method: "HEAD", url: "https://shop.example.com/x" },
      { method: "OPTIONS", url: "https://api.example.com/orders", resourceType: "Preflight" },
      { method: "POST", url: "https://shop.example.com/api/orders", resourceType: "Fetch" },
      { method: "PUT", url: "https://shop.example.com/api/profile", resourceType: "XHR" },
      { method: "DELETE", url: "https://shop.example.com/api/items/4", resourceType: "Fetch" },
      { method: "patch", url: "https://other.example.net/api", resourceType: "Fetch" },
      { method: "POST", url: "https://shop.example.com/checkout", resourceType: "Document", mainFrame: true },
    ]);
    expect(verdicts).toEqual(["go", "go", "go", "stop", "stop", "stop", "stop", "stop"]);
  });

  it("drops beacons and well-known analytics quietly, but not a look-alike", () => {
    const { verdicts } = judge([
      { method: "POST", url: "https://www.google-analytics.com/g/collect?v=2", resourceType: "Fetch" },
      { method: "POST", url: "https://api.segment.io/v1/t", resourceType: "XHR" },
      { method: "POST", url: "https://shop.example.com/_track", resourceType: "Ping" },
      { method: "POST", url: "https://px.ads.linkedin.com/collect", resourceType: "Fetch" },
      { method: "POST", url: "https://www.linkedin.com/px/li_sync", resourceType: "Fetch" },
      { method: "POST", url: "https://www.linkedin.com/voyager/api/messaging", resourceType: "Fetch" },
      { method: "POST", url: "https://google-analytics.com.evil.example/collect", resourceType: "Fetch" },
      { method: "POST", url: "https://notsentry.io/api", resourceType: "Fetch" },
    ]);
    expect(verdicts).toEqual(["quiet", "quiet", "quiet", "quiet", "quiet", "stop", "stop", "stop"]);
  });

  it("stops judging once the click navigated the tab: the next page's own loading is not what the click sent", () => {
    const { verdicts, state } = judge([
      { method: "GET", url: "https://shop.example.com/orders", resourceType: "Document", mainFrame: true },
      { method: "POST", url: "https://shop.example.com/api/log-view", resourceType: "Fetch" },
    ]);
    expect(verdicts).toEqual(["go", "go"]);
    expect(state.navigated).toBe(true);
  });

  it("does not count a frame inside the page loading as the tab navigating", () => {
    const { verdicts } = judge([
      { method: "GET", url: "https://ads.example.net/frame", resourceType: "Document", mainFrame: false },
      { method: "POST", url: "https://shop.example.com/api/orders", resourceType: "Fetch" },
    ]);
    expect(verdicts).toEqual(["go", "stop"]);
  });

  it("refuses arguments that are not what the gate sends", () => {
    const answer = parseGuardAnswer(
      (() => {
        try {
          return execFileSync(process.execPath, [program, "arm", "9301", "$(id)", "30000"], { encoding: "utf8" });
        } catch (error) {
          return String((error as { stdout?: string }).stdout ?? "");
        }
      })(),
    );
    expect(answer.ok).toBe(false);
  });
});
