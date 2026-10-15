import { describe, expect, it } from "vitest";

import { suggestName, templateById, TEMPLATES } from "../agent/lib/templates";

/** Hiring templates (H1): complete, and the names they suggest are free ones. */
describe("templates", () => {
  it("each brings a job, a persona long enough to hire with, skills, and an introduction with three starters", () => {
    for (const template of TEMPLATES) {
      expect(template.role.length).toBeLessThanOrEqual(120);
      expect(template.persona.length).toBeGreaterThanOrEqual(20);
      expect(template.skills.length).toBeGreaterThan(0);
      expect(template.intro.starters).toHaveLength(3);
      expect(template.names.length).toBeGreaterThan(1);
    }
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length);
  });

  it("looks a template up only by a known id", () => {
    expect(templateById("researcher")?.title).toBe("Researcher");
    expect(templateById("nope")).toBeNull();
    expect(templateById(42)).toBeNull();
  });

  it("suggests a name no one on the team has, cycling through the free ones", () => {
    const researcher = templateById("researcher")!;
    expect(suggestName(researcher, [])).toBe("Scout");
    expect(suggestName(researcher, ["scout", "Atlas"])).toBe("Sage");
    expect(suggestName(researcher, ["Scout", "Atlas"], 1)).toBe("Iris");
    expect(suggestName(researcher, researcher.names)).toBe("Scout 2");
    expect(suggestName(researcher, [...researcher.names, "Scout 2"])).toBe("Scout 3");
  });
});
