// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueState } from "../core/issues";
import { fiveIssues, FIVE_TEXT, newState, placed } from "../core/issues/testing/helpers";
import { EditorMirror, issueBoxes, issueIdAtPoint } from "./mirror";
import { IssueTooltip, tooltipLines } from "./tooltip";

describe("issueIdAtPoint", () => {
  const issues = [
    // An issue that wraps onto two lines has two rectangles.
    {
      id: 1,
      boxes: [
        { left: 100, top: 10, right: 300, bottom: 30 },
        { left: 0, top: 30, right: 50, bottom: 50 },
      ],
    },
    { id: 2, boxes: [{ left: 60, top: 30, right: 120, bottom: 50 }] },
    { id: 3, boxes: [] },
  ];

  it.each([
    { name: "inside the first rectangle", x: 150, y: 20, expected: 1 },
    { name: "inside the second line of a wrapped issue", x: 20, y: 40, expected: 1 },
    {
      name: "between the two lines of a wrapped issue, on the first line's right",
      x: 20,
      y: 20,
      expected: undefined,
    },
    { name: "inside another issue", x: 80, y: 40, expected: 2 },
    { name: "on the left edge (inclusive)", x: 100, y: 10, expected: 1 },
    { name: "on the right edge (exclusive)", x: 300, y: 20, expected: undefined },
    { name: "on the bottom edge (exclusive)", x: 150, y: 30, expected: undefined },
    { name: "outside everything", x: 500, y: 500, expected: undefined },
  ])("$name", ({ x, y, expected }) => {
    expect(issueIdAtPoint(issues, x, y)).toBe(expected);
  });
});

describe("tooltipLines", () => {
  it("is the label and the category, then the message", () => {
    const { state } = newState();
    state.beginCheck(true);
    state.finishCheck([placed(0, 4, "subject_verb_agreement", "Use goes.")], FIVE_TEXT, 0);
    const issue = state.issues[0];
    expect(tooltipLines(issue!)).toEqual(["Subject-verb agreement · Grammar", "Use goes."]);
  });
});

describe("IssueTooltip", () => {
  let textarea: HTMLTextAreaElement;
  let mirrorElement: HTMLElement;
  let state: IssueState;
  let mirror: EditorMirror;
  let tooltip: IssueTooltip;

  beforeEach(() => {
    document.body.replaceChildren();
    textarea = document.createElement("textarea");
    mirrorElement = document.createElement("div");
    document.body.append(mirrorElement, textarea);
    textarea.value = FIVE_TEXT;
    state = newState().state;
    mirror = new EditorMirror(document, textarea, mirrorElement, state);
    tooltip = new IssueTooltip(document, textarea, mirrorElement, state);
    state.beginCheck(true);
    state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
    // Each issue's span is a 40x20 box at x = 50 * (id - 1), y = 100 (happy-dom has no layout).
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const id = Number((this as HTMLElement).dataset.issueId);
      return (Number.isInteger(id)
        ? [new DOMRect(50 * (id - 1), 100, 40, 20)]
        : []) as unknown as DOMRectList;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tooltip.destroy();
    mirror.destroy();
  });

  const el = () => document.getElementById("issue-tooltip")!;
  const move = (x: number, y: number) =>
    textarea.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));

  it("is one element, hidden, with the tooltip role, and not a title attribute", () => {
    expect(document.querySelectorAll("#issue-tooltip")).toHaveLength(1);
    expect(el().hidden).toBe(true);
    expect(el().getAttribute("role")).toBe("tooltip");
    expect(textarea.hasAttribute("title")).toBe(false);
    expect(mirrorElement.querySelector("[title]")).toBeNull();
  });

  it("collects the rectangles of the mirror's spans", () => {
    expect(issueBoxes(mirrorElement).map((i) => i.id)).toEqual(state.issues.map((i) => i.id));
  });

  it.each([
    { x: 10, y: 110, title: "Verb form · Grammar", id: 0 },
    { x: 120, y: 105, title: "Collocation · Vocabulary", id: 2 },
    { x: 220, y: 119, title: "Word order · Syntax", id: 4 },
  ])("hovering ($x, $y) shows '$title' and the message", ({ x, y, title, id }) => {
    move(x, y);
    expect(el().hidden).toBe(false);
    expect(el().querySelector(".tip-title")?.textContent).toBe(title);
    expect(el().querySelector(".tip-message")?.textContent).toBe("m");
    expect(tooltip.current).toBe(state.issues[id]?.id);
    expect(textarea.getAttribute("aria-describedby")).toBe("issue-tooltip");
  });

  it("shows nothing between underlines or off the text, and hides when the mouse moves away", () => {
    move(45, 110); // in the gap between two spans
    expect(el().hidden).toBe(true);
    move(10, 110);
    expect(el().hidden).toBe(false);
    move(45, 110);
    expect(el().hidden).toBe(true);
    expect(textarea.hasAttribute("aria-describedby")).toBe(false);
  });

  it("switches from one issue to the next", () => {
    move(10, 110);
    move(60, 110);
    expect(el().querySelector(".tip-title")?.textContent).toBe("Article · Grammar");
  });

  it("has no tooltip for a hidden category", () => {
    state.setHidden("vocabulary", true);
    move(110, 110); // where "cccc" (vocabulary) is
    expect(el().hidden).toBe(true);
    expect(tooltip.current).toBeNull();
    move(60, 110); // "bbbb" (grammar) still has one
    expect(el().hidden).toBe(false);
  });

  it.each(["mouseleave", "mousedown", "keydown", "wheel", "scroll", "input"])(
    "hides on %s",
    (type) => {
      move(10, 110);
      textarea.dispatchEvent(new Event(type));
      expect(el().hidden).toBe(true);
    },
  );

  it("hides when the issues change under it", () => {
    move(10, 110);
    state.applyEdit({ start: 100, removed: 0, added: 1 });
    expect(el().hidden).toBe(false); // nothing changed for the issues
    state.applyEdit({ start: 2, removed: 0, added: 1 });
    expect(el().hidden).toBe(true);
  });

  it("is placed near the pointer, and kept inside the window", () => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 300,
      configurable: true,
    });
    Object.defineProperty(el(), "offsetWidth", { value: 150, configurable: true });
    Object.defineProperty(el(), "offsetHeight", { value: 40, configurable: true });
    move(10, 110);
    expect([el().style.left, el().style.top]).toEqual(["24px", "124px"]);
    // Near the right edge: moved left. Near the bottom: above the pointer.
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
      () => [new DOMRect(350, 270, 40, 20)] as unknown as DOMRectList,
    );
    move(380, 280);
    expect([el().style.left, el().style.top]).toEqual(["242px", "226px"]);
  });

  it("writes the message as text, never as markup", () => {
    const { state: other } = newState();
    other.beginCheck(true);
    other.finishCheck([placed(0, 4, "verb_form", "<img src=x onerror=alert(1)>")], FIVE_TEXT, 0);
    const lines = tooltipLines(other.issues[0]!);
    expect(lines[1]).toBe("<img src=x onerror=alert(1)>");
    state.beginCheck(true);
    state.finishCheck([placed(0, 4, "verb_form", "<img src=x onerror=alert(1)>")], FIVE_TEXT, 0);
    move(50 * ((state.issues[0]?.id ?? 1) - 1) + 10, 110);
    expect(el().querySelector("img")).toBeNull();
    expect(el().querySelector(".tip-message")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("is removed on destroy", () => {
    tooltip.destroy();
    expect(document.getElementById("issue-tooltip")).toBeNull();
  });
});
