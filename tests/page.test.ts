import { describe, expect, it } from "vitest";

import { compareTrees, trimTree } from "../agent/subagents/teammate/lib/page";

/** A slice of a real inbox-like tree: wrappers, line breaks, repeated container text, and controls. */
const TREE = `[BEGIN PAGE CONTENT]
- LayoutTable
  - LayoutTableRow
    - LayoutTableCell "Hacker Newsnew | past | comments | ask | show | jobs | submit login"
      - LayoutTable
        - LayoutTableRow
          - LayoutTableCell
            - link [ref=e101]
              - image
          - LayoutTableCell "Hacker Newsnew | past | comments | ask | show | jobs | submit"
            - link "Hacker News" [ref=e102]
            - link "new" [ref=e103]
          - LayoutTableCell "login"
            - link "login" [ref=e110]
          - cell "1."
  - LineBreak "\\n"
  - LayoutTableRow
    - heading "Inbox" [level=1]
    - StaticText "3 unread"
    - generic
      - paragraph
        - StaticText "${"A very long body of text that goes on and on. ".repeat(8)}"
    - textbox "Search mail" [ref=e7]
    - button "Send" [ref=e12] [disabled]
[END PAGE CONTENT]`;

describe("trimTree", () => {
  it("drops noise and repeated container text, keeps refs, headings, and text, and the boundary markers", () => {
    const trimmed = trimTree(TREE, 100_000);
    expect(trimmed.level).toBe(0);
    expect(trimmed.text.startsWith("[BEGIN PAGE CONTENT]")).toBe(true);
    expect(trimmed.text.endsWith("[END PAGE CONTENT]")).toBe(true);
    expect(trimmed.text).not.toMatch(/LineBreak|- image$|- generic$|- LayoutTable$|- LayoutTableRow$|- paragraph$/m);
    expect(trimmed.text).toContain('- link "Hacker News" [ref=e102]');
    expect(trimmed.text).toContain('- heading "Inbox" [level=1]');
    expect(trimmed.text).toContain('- button "Send" [ref=e12] [disabled]');
    expect(trimmed.text).toContain("3 unread");
    // Containers that only repeat their children's text are gone; a named leaf stays.
    expect(trimmed.text).not.toContain("Hacker Newsnew");
    expect(trimmed.text).not.toContain('LayoutTableCell "login"');
    expect(trimmed.text).toContain('- link "login" [ref=e110]');
    expect(trimmed.text).toContain('- cell "1."');
    expect(trimmed.text).toMatch(/StaticText "A very long body[^"]*…"/);
    expect(trimmed.interactive).toBe(6);
  });

  it("cuts in order of what a Bot can spare, and says what it left out at the hard limit", () => {
    const whole = trimTree(TREE, 100_000).text.length;
    const textual = trimTree(TREE, whole - 1);
    expect(textual.level).toBe(1);
    expect(textual.text).not.toContain('cell "1."');
    expect(textual.text).toContain("3 unread");
    expect(textual.text).toContain("[ref=e7]");

    const essential = trimTree(TREE, textual.text.length - 1);
    expect(essential.level).toBe(2);
    expect(essential.text).not.toContain("3 unread");
    expect(essential.text).toContain('heading "Inbox"');
    expect(essential.text).toContain("[ref=e12]");

    const hard = trimTree(TREE, essential.text.length - 1);
    expect(hard.level).toBe(3);
    expect(hard.text.length).toBeLessThan(essential.text.length);
    expect(hard.text).toMatch(/more lines not shown \(\d+ interactive\)/);
    expect(hard.shown).toBeLessThan(hard.of);
  });

  it("never invents refs: every ref in the trimmed tree is in the snapshot", () => {
    const refs = (text: string) => [...text.matchAll(/\[ref=(e\d+)\]/g)].map((match) => match[1]).sort();
    for (const budget of [100_000, 600, 420, 250]) {
      const shown = refs(trimTree(TREE, budget).text);
      expect(refs(TREE)).toEqual(expect.arrayContaining(shown));
    }
  });
});

describe("trimTree on input that is not a tree", () => {
  it("keeps the text instead of trimming everything away", () => {
    const notATree = '{"error":"the page could not be read","status":500}';
    const trimmed = trimTree(notATree, 8_000);
    expect(trimmed.text).toContain('"error"');
    expect(trimmed.text).not.toMatch(/more lines not shown/);
  });

  it("clips a long non-tree page to the budget rather than dropping it", () => {
    const long = "x".repeat(50_000);
    const trimmed = trimTree(long, 1_000);
    expect(trimmed.text.length).toBeLessThanOrEqual(1_000);
    expect(trimmed.text).toContain("xxx");
  });
});

describe("compareTrees", () => {
  const before = { url: "https://mail.example/inbox", tree: '- heading "Inbox"\n- link "Acme invoice" [ref=e3]\n- button "Compose" [ref=e4]' };

  it("reports an action that changed nothing as exactly that", () => {
    const same = { url: before.url, tree: before.tree };
    const change = compareTrees(before, same);
    expect(change.kind).toBe("none");
    expect(change.refsMoved).toBe(false);
  });

  it("says the refs moved when the same page re-renders under new refs", () => {
    const renumbered = { url: before.url, tree: '- heading "Inbox"\n- link "Acme invoice" [ref=e9]\n- button "Compose" [ref=e10]' };
    const change = compareTrees(before, renumbered);
    // The words are unchanged, so the content question is still "none"...
    expect(change.kind).toBe("none");
    // ...but every handle the bot held is gone.
    expect(change.refsMoved).toBe(true);
  });

  it("lists what appeared with its refs, and what went, when part of the page changed", () => {
    const after = { url: before.url, tree: '- heading "Inbox"\n- link "Acme invoice" [ref=e3]\n- button "Compose" [ref=e4]\n- dialog "New message" [ref=e20]\n- textbox "To" [ref=e21]' };
    const change = compareTrees(before, after);
    expect(change.kind).toBe("some");
    expect(change.added).toEqual(['- dialog "New message" [ref=e20]', '- textbox "To" [ref=e21]']);
    expect(change.removed).toEqual([]);
    const gone = compareTrees(after, before);
    expect(gone.kind).toBe("some");
    expect(gone.removed).toEqual(['- dialog "New message"', '- textbox "To"']);
  });

  it("calls a new URL, or a mostly different tree, a new page", () => {
    expect(compareTrees(before, { url: "https://mail.example/sent", tree: before.tree }).kind).toBe("page");
    expect(compareTrees(before, { url: before.url, tree: '- heading "Settings"\n- link "General" [ref=e1]\n- link "Labels" [ref=e2]' }).kind).toBe("page");
  });
});
