import { describe, expect, it } from "vitest";
import { fiveIssues, FIVE_TEXT, newState } from "./testing/helpers";
import { TrackedText } from "./tracked-text";

function checked() {
  const { state } = newState();
  state.beginCheck(true);
  state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
  return { state, text: new TrackedText(state, FIVE_TEXT) };
}

describe("TrackedText", () => {
  it.each([
    {
      name: "typing before everything",
      next: `Oh. ${FIVE_TEXT}`,
      snippets: ["bbbb", "cccc", "dddd", "eeee"],
    },
    {
      name: "typing inside the third issue",
      next: "aaaa bbbb ccXcc dddd eeee",
      snippets: ["aaaa", "bbbb", "dddd", "eeee"],
    },
    {
      name: "typing at the end",
      next: `${FIVE_TEXT}.`,
      snippets: ["aaaa", "bbbb", "cccc", "dddd"],
    },
    {
      name: "deleting a whole issue and its space",
      next: "aaaa cccc dddd eeee",
      snippets: ["aaaa", "dddd", "eeee"],
    },
    { name: "the same text", next: FIVE_TEXT, snippets: ["aaaa", "bbbb", "cccc", "dddd", "eeee"] },
  ])("$name", ({ next, snippets }) => {
    const { state, text } = checked();
    text.changed(next);
    expect(state.issues.map((i) => i.snippet)).toEqual(snippets);
    // The kept issues still sit on their words in the new text.
    for (const issue of state.issues)
      expect(next.slice(issue.start, issue.end)).toBe(issue.snippet);
    expect(text.text).toBe(next);
  });

  it("does not count a change that changed nothing", () => {
    const { state, text } = checked();
    text.changed(FIVE_TEXT);
    expect(state.revision).toBe(0);
  });

  it("follows many edits: every kept issue stays on its word", () => {
    const { state, text } = checked();
    let current = FIVE_TEXT;
    for (const next of [
      `x${current}`,
      `x${current}`.replace("eeee", "eeee!"),
      "x aaaa bbbb cccc dddd eeee!",
    ]) {
      text.changed(next);
      current = next;
      for (const issue of state.issues) {
        expect(current.slice(issue.start, issue.end)).toBe(issue.snippet);
      }
    }
  });

  it("load() clears the issues and is not an edit that a check can rebase across", () => {
    const { state, text } = checked();
    state.beginCheck(true);
    text.load("a new text");
    expect(state.issues).toEqual([]);
    expect(state.editsDuringCheck).toBeUndefined();
    expect(text.text).toBe("a new text");
    // And the next change is measured against the loaded text.
    text.changed("a new text!");
    expect(state.revision).toBe(2);
  });
});
