// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueState, TextIssue } from "../core/issues";
import { fiveIssues, FIVE_TEXT, newState, placed } from "../core/issues/testing/helpers";
import { EditorMirror, mirrorNodes } from "./mirror";

/** The zero-width space that ends the mirror's text. */
const END = String.fromCharCode(0x200b);

function withoutEndMark(text: string | null): string {
  return (text ?? "").replace(END, "");
}

function issuesOf(...specs: [number, number, string?][]): TextIssue[] {
  const { state } = newState();
  state.beginCheck(true);
  state.finishCheck(
    specs.map(([start, end, type]) => placed(start, end, type)),
    "x".repeat(200),
    0,
  );
  return [...state.issues];
}

function render(text: string, issues: readonly TextIssue[], selectedId: number | null = null) {
  const holder = document.createElement("div");
  holder.append(...mirrorNodes(document, text, issues, selectedId));
  return holder;
}

const spans = (holder: HTMLElement) => [...holder.querySelectorAll<HTMLElement>("span.issue")];

describe("mirrorNodes", () => {
  it("holds the whole text, and wraps each issue in a span of its category", () => {
    const issues = issuesOf([0, 4, "verb_form"], [10, 14, "collocation"], [20, 24, "word_order"]);
    const holder = render(FIVE_TEXT, issues);
    expect(withoutEndMark(holder.textContent)).toBe(FIVE_TEXT);
    expect(spans(holder).map((s) => [s.textContent, s.className])).toEqual([
      ["aaaa", "issue issue-grammar"],
      ["cccc", "issue issue-vocabulary"],
      ["eeee", "issue issue-syntax"],
    ]);
    expect(spans(holder).map((s) => s.dataset.issueId)).toEqual(issues.map((i) => String(i.id)));
  });

  it("marks the selected issue", () => {
    const issues = issuesOf([0, 4], [5, 9]);
    const holder = render(FIVE_TEXT, issues, issues[1]?.id ?? null);
    expect(spans(holder).map((s) => s.classList.contains("issue-selected"))).toEqual([false, true]);
  });

  it("starts and ends with plain text around the spans", () => {
    const holder = render(FIVE_TEXT, issuesOf([5, 9]));
    expect([...holder.childNodes].map((n) => n.textContent)).toEqual([
      "aaaa ",
      "bbbb",
      ` cccc dddd eeee${END}`,
    ]);
  });

  it.each([
    { name: "past the end of the text", issues: [[20, 40]] as [number, number][] },
    { name: "empty", issues: [[5, 5]] as [number, number][] },
    {
      name: "overlapping an earlier one",
      issues: [
        [0, 6],
        [4, 9],
      ] as [number, number][],
    },
  ])("skips an issue that is $name, and keeps the text", ({ issues }) => {
    const holder = render(FIVE_TEXT, issuesOf(...issues));
    expect(withoutEndMark(holder.textContent)).toBe(FIVE_TEXT);
    expect(spans(holder).length).toBeLessThanOrEqual(1);
  });

  it("gives a text that ends in a line break its last empty line", () => {
    const holder = render("a\n", []);
    expect(holder.textContent).toBe(`a\n${END}`);
  });

  it("puts text in text nodes, so markup in the text stays text", () => {
    const text = "<b>bold</b>";
    const holder = render(text, issuesOf([0, 3]));
    expect(holder.querySelector("b")).toBeNull();
    expect(withoutEndMark(holder.textContent)).toBe(text);
  });
});

describe("EditorMirror", () => {
  let state: IssueState;
  let textarea: HTMLTextAreaElement;
  let mirrorElement: HTMLElement;
  let mirror: EditorMirror;

  beforeEach(() => {
    document.body.replaceChildren();
    textarea = document.createElement("textarea");
    mirrorElement = document.createElement("div");
    document.body.append(mirrorElement, textarea);
    state = newState().state;
    textarea.value = FIVE_TEXT;
    mirror = new EditorMirror(document, textarea, mirrorElement, state);
  });

  afterEach(() => {
    mirror.destroy();
  });

  const shown = () => spans(mirrorElement).map((s) => s.textContent);

  it("shows the text without underlines before a check", () => {
    expect(shown()).toEqual([]);
    expect(mirrorElement.textContent).toBe(`${FIVE_TEXT}${END}`);
  });

  it("draws one span per issue when a check finishes, matching the issues", () => {
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    expect(shown()).toEqual(state.issues.map((i) => i.snippet));
    expect(spans(mirrorElement).map((s) => s.className.split(" ")[1])).toEqual([
      "issue-grammar",
      "issue-grammar",
      "issue-vocabulary",
      "issue-vocabulary",
      "issue-syntax",
    ]);
  });

  it("leaves out the issues of a hidden category and brings them back", () => {
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    state.setHidden("vocabulary", true);
    expect(shown()).toEqual(["aaaa", "bbbb", "eeee"]);
    state.setHidden("vocabulary", false);
    expect(shown()).toHaveLength(5);
  });

  it("highlights the selected issue only", () => {
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    state.select(state.issues[3]?.id ?? 0);
    expect(
      spans(mirrorElement)
        .filter((s) => s.classList.contains("issue-selected"))
        .map((s) => s.textContent),
    ).toEqual(["dddd"]);
    state.select(null);
    expect(mirrorElement.querySelector(".issue-selected")).toBeNull();
  });

  it("follows the textarea's text when the user types", () => {
    textarea.value = `${FIVE_TEXT} more`;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mirrorElement.textContent).toBe(`${FIVE_TEXT} more${END}`);
  });

  it("follows the textarea's scroll position", () => {
    textarea.scrollTop = 40;
    textarea.dispatchEvent(new Event("scroll"));
    expect(mirrorElement.scrollTop).toBe(textarea.scrollTop);
  });

  it("never changes the textarea", () => {
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    expect(textarea.value).toBe(FIVE_TEXT);
    expect(textarea.childNodes).toHaveLength(0);
  });

  it("stops drawing after destroy", () => {
    mirror.destroy();
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    expect(shown()).toEqual([]);
  });
});
