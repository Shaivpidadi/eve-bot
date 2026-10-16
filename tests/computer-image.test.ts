import { readFileSync } from "node:fs";
import path from "node:path";

import { AGENT_BROWSER_SANDBOX_VERSION } from "@agent-browser/sandbox";
import { describe, expect, it } from "vitest";

import { computerImage } from "../agent/lib/computer-config";

/** The team computer's software comes from an image (agent/sandbox/Dockerfile), installed at first boot otherwise. */
const root = path.resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(path.join(root, "agent/sandbox/Dockerfile"), "utf8");
const script = readFileSync(path.join(root, "agent/lib/computer/script.ts"), "utf8");

describe("computerImage", () => {
  it("builds the Dockerfile locally, keeps eve's base on Vercel, and takes a named image anywhere", () => {
    expect(computerImage({ BOT_COMPUTER: "local" })).toEqual({ kind: "dockerfile" });
    expect(computerImage({})).toEqual({ kind: "default" });
    expect(computerImage({ BOT_COMPUTER_IMAGE: "vcr.vercel.com/acme/bot-computer:1" })).toEqual({ kind: "image", reference: "vcr.vercel.com/acme/bot-computer:1" });
    expect(computerImage({ BOT_COMPUTER: "local", BOT_COMPUTER_IMAGE: "default" })).toEqual({ kind: "default" });
  });
});

describe("agent/sandbox/Dockerfile", () => {
  it("installs every package the computer's installer checks for", () => {
    const packages = /^PACKAGES="([^"]+)"/m.exec(script)?.[1]?.split(/\s+/) ?? [];
    expect(packages.length).toBeGreaterThan(10);
    for (const name of packages) expect(dockerfile, `${name} is missing from the Dockerfile`).toMatch(new RegExp(`(^|\\s)${name.replace(/[.+]/g, "\\$&")}(\\s|\\\\|$)`, "m"));
  });

  it("installs Chrome and the agent-browser version eve's installer would", () => {
    expect(dockerfile).toContain("google-chrome-stable_current_${arch}.deb");
    expect(dockerfile).toContain(`npm install -g agent-browser@${AGENT_BROWSER_SANDBOX_VERSION}`);
  });
});
