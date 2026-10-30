// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueState } from "../core/issues";
import { fiveIssues, FIVE_TEXT, newState } from "../core/issues/testing/helpers";
import { EditorSelection } from "./editor-selection";
import { EditorMirror } from "./mirror";

let textarea: HTMLTextAreaElement;
let mirrorElement: HTMLElement;
let state: IssueState;
let mirror: EditorMirror;
let selection: EditorSelection;

beforeEach(() => {
  document.body.replaceChildren();
  textarea = document.createElement("textarea");
  mirrorElement = document.createElement("div");
  document.body.append(mirrorElement, textarea);
  textarea.value = FIVE_TEXT;
  state = newState().state;
  mirror = new EditorMirror(document, textarea, mirrorElement, state);
  selection = new EditorSelection(textarea, mirrorElement, state);
  state.beginCheck(true);
  state.finishCheck(fiveIssues(), FIVE_TEXT, 0);
});

afterEach(() => {
  vi.restoreAllMocks();
  selection.destroy();
  mirror.destroy();
});

const caretTo = (offset: number, type = "selectionchange") => {
  textarea.setSelectionRange(offset, offset);
  textarea.dispatchEvent(new Event(type));
};
const selected = () => state.selected?.snippet;

describe("the caret selects an issue (SPEC section 4.3)", () => {
  it.each([
    { caret: 0, expected: "aaaa" },
    { caret: 2, expected: "aaaa" },
    { caret: 4, expected: undefined },
    { caret: 5, expected: "bbbb" },
    { caret: 12, expected: "cccc" },
    { caret: 24, expected: undefined },
  ])("a caret at $caret selects $expected", ({ caret, expected }) => {
    caretTo(caret);
    expect(selected()).toBe(expected);
  });

  it.each(["selectionchange", "keyup", "mouseup", "focus", "select"])("on %s", (type) => {
    caretTo(12, type);
    expect(selected()).toBe("cccc");
  });

  it("does not move the caret", () => {
    textarea.setSelectionRange(7, 7);
    textarea.dispatchEvent(new Event("selectionchange"));
    expect(textarea.selectionStart).toBe(7);
    expect(textarea.selectionEnd).toBe(7);
  });

  it("moving outside all issues clears the selection, and moving to another switches it", () => {
    caretTo(1);
    expect(selected()).toBe("aaaa");
    caretTo(11);
    expect(selected()).toBe("cccc");
    caretTo(24);
    expect(state.selectedId).toBeNull();
  });

  it("uses the start of a selected range of text", () => {
    textarea.setSelectionRange(10, 14);
    textarea.dispatchEvent(new Event("selectionchange"));
    expect(selected()).toBe("cccc");
  });

  it("ignores issues of a hidden category", () => {
    state.setHidden("vocabulary", true);
    caretTo(12);
    expect(state.selectedId).toBeNull();
  });

  it("is not moved by its own selection (no caret jump back to the start)", () => {
    caretTo(12);
    expect(textarea.selectionStart).toBe(12);
  });
});

describe("an issue selected from elsewhere (a row, F7)", () => {
  it("puts the caret at its start, without taking the focus", () => {
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    state.select(state.issues[3]?.id ?? 0);
    expect(textarea.selectionStart).toBe(15);
    expect(textarea.selectionEnd).toBe(15);
    expect(document.activeElement).toBe(other);
  });

  /** Happy-dom has no layout: gives the span of each issue id the rectangles `rects` says. */
  function layout(rects: Record<number, DOMRect>): void {
    Object.defineProperty(textarea, "clientHeight", { value: 200, configurable: true });
    mirrorElement.getBoundingClientRect = () => new DOMRect(0, 100, 300, 200);
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const rect = rects[Number((this as HTMLElement).dataset.issueId)];
      return (rect === undefined ? [] : [rect]) as unknown as DOMRectList;
    });
  }

  it("scrolls the editor so that an issue out of view is in the middle of it", () => {
    // The span is on screen at y = 600, that is 500 below the mirror's top; it is 20 high.
    layout({ 4: new DOMRect(10, 600, 40, 20) });
    textarea.scrollTop = 0;
    state.select(4);
    expect(textarea.scrollTop).toBe(500 - (200 - 20) / 2);
  });

  it("scrolls up to an issue above the view", () => {
    layout({ 2: new DOMRect(10, -300, 40, 20) });
    textarea.scrollTop = 900;
    state.select(2);
    expect(textarea.scrollTop).toBe(900 + (-300 - 100) - (200 - 20) / 2);
  });

  it("does not scroll an issue that is in view", () => {
    layout({ 2: new DOMRect(10, 160, 40, 20) });
    textarea.scrollTop = 7;
    state.select(2);
    expect(textarea.scrollTop).toBe(7);
  });

  it("still puts the caret there when the issue has no rectangles (nothing to scroll to)", () => {
    state.select(state.issues[2]?.id ?? 0);
    expect(textarea.selectionStart).toBe(10);
  });

  it("focusSelected() takes the focus with the caret at the start", () => {
    state.select(state.issues[1]?.id ?? 0);
    selection.focusSelected();
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(5);
  });

  it("focusSelected() with nothing selected only focuses the editor", () => {
    selection.focusSelected();
    expect(document.activeElement).toBe(textarea);
    expect(state.selectedId).toBeNull();
  });

  it("stops listening after destroy", () => {
    selection.destroy();
    caretTo(12);
    expect(state.selectedId).toBeNull();
    state.select(state.issues[3]?.id ?? 0);
    expect(textarea.selectionStart).toBe(12);
  });
});
