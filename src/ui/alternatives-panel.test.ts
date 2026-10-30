// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  AlternativesPanel,
  SELECTED_PREVIEW_CHARS,
  selectedPreview,
  type AlternativesPanelHandlers,
} from "./alternatives-panel";

let host: HTMLElement;
let panel: AlternativesPanel;
let calls: string[];

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
  calls = [];
  const handlers: AlternativesPanelHandlers = {
    use: (text) => calls.push(`use:${text}`),
    copy: (text) => calls.push(`copy:${text}`),
    retry: () => calls.push("retry"),
    close: () => calls.push("close"),
  };
  panel = new AlternativesPanel(document, host, handlers);
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const rows = () => [...host.querySelectorAll<HTMLElement>(".alt-row")];
const selectedRows = () =>
  rows().flatMap((r, i) => (r.getAttribute("aria-selected") === "true" ? [i] : []));
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const dblclick = (el: Element) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
function key(k: string, target: HTMLElement = q("#alt-list")): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
const visible = (selector: string) => !q(selector).hidden;

describe("AlternativesPanel states", () => {
  it("starts closed and hidden", () => {
    expect(panel.state).toBe("closed");
    expect(panel.isOpen).toBe(false);
    expect(q("#alternatives").hidden).toBe(true);
  });

  it("loading: the selected text, the state line and a busy indicator, no list or buttons", () => {
    panel.showLoading("take a photo");
    expect(panel.state).toBe("loading");
    expect(q("#alternatives").dataset.state).toBe("loading");
    expect(q("#alt-selected").textContent).toBe("take a photo");
    expect(q("#alt-state").textContent).toBe("Looking for alternatives...");
    expect(visible(".spinner")).toBe(true);
    expect(q("#alt-list").hidden).toBe(true);
    expect(q("#alt-copy").hidden).toBe(true);
    expect(q("#alt-retry").hidden).toBe(true);
    expect(visible("#alt-close")).toBe(true);
  });

  it.each([
    { alternatives: ["one", "two", "three"], line: "3 alternatives" },
    { alternatives: ["only"], line: "1 alternative" },
  ])("ready with $alternatives.length: $line, first row selected", ({ alternatives, line }) => {
    panel.showLoading("x");
    panel.showReady(alternatives);
    expect(panel.state).toBe("ready");
    expect(q("#alt-state").textContent).toBe(line);
    expect(rows().map((r) => r.textContent)).toEqual(alternatives);
    expect(selectedRows()).toEqual([0]);
    expect(visible(".spinner")).toBe(false);
    expect(visible("#alt-copy")).toBe(true);
    expect(visible("#alt-retry")).toBe(false);
    expect(panel.selectedText).toBe(alternatives[0]);
  });

  it("ready with nothing says so and has no list or Copy", () => {
    panel.showReady([]);
    expect(q("#alt-state").textContent).toBe("No alternatives found.");
    expect(q("#alt-list").hidden).toBe(true);
    expect(q("#alt-copy").hidden).toBe(true);
    expect(panel.selectedText).toBeUndefined();
  });

  it("failed: 'Could not get alternatives.', the message in red and Retry", () => {
    panel.showLoading("x");
    panel.showFailed("The request to Local failed (HTTP 500).");
    expect(panel.state).toBe("failed");
    expect(q("#alt-state").textContent).toBe("Could not get alternatives.");
    expect(q("#alt-error").textContent).toBe("The request to Local failed (HTTP 500).");
    expect(visible("#alt-error")).toBe(true);
    expect(visible("#alt-retry")).toBe(true);
    expect(q("#alt-copy").hidden).toBe(true);
    click(q("#alt-retry"));
    expect(calls).toEqual(["retry"]);
  });

  it("showing it again replaces the earlier content", () => {
    panel.showLoading("first");
    panel.showReady(["a", "b"]);
    panel.showNote("old note");
    panel.showLoading("second");
    expect(q("#alt-selected").textContent).toBe("second");
    expect(rows()).toHaveLength(0);
    expect(q("#alt-note").hidden).toBe(true);
    expect(host.querySelectorAll("#alternatives")).toHaveLength(1);
  });

  it("close hides it without calling a handler", () => {
    panel.showReady(["a"]);
    panel.close();
    expect(panel.state).toBe("closed");
    expect(q("#alternatives").hidden).toBe(true);
    expect(calls).toEqual([]);
  });

  it("a note shows under the list and clears", () => {
    panel.showReady(["a"]);
    panel.showNote("The text changed, so nothing was replaced.");
    expect(visible("#alt-note")).toBe(true);
    expect(q("#alt-note").textContent).toBe("The text changed, so nothing was replaced.");
    expect(rows()).toHaveLength(1);
    panel.clearNote();
    expect(q("#alt-note").hidden).toBe(true);
  });
});

describe("AlternativesPanel selected text", () => {
  it.each([
    { name: "short", text: "abc", shown: "abc" },
    { name: "exactly 400", text: "a".repeat(400), shown: "a".repeat(400) },
    { name: "401", text: "a".repeat(401), shown: `${"a".repeat(400)}…` },
    { name: "emoji at the cut", text: "😀".repeat(401), shown: `${"😀".repeat(400)}…` },
  ])("cuts to $name characters at most", ({ text, shown }) => {
    expect(selectedPreview(text)).toBe(shown);
    panel.showLoading(text);
    expect(q("#alt-selected").textContent).toBe(shown);
    expect(SELECTED_PREVIEW_CHARS).toBe(400);
  });
});

describe("AlternativesPanel actions", () => {
  beforeEach(() => {
    panel.showReady(["one", "two", "three"]);
  });

  it("a click selects a row, a double click uses it", () => {
    click(rows()[1]!);
    expect(selectedRows()).toEqual([1]);
    expect(calls).toEqual([]);
    dblclick(rows()[2]!);
    expect(selectedRows()).toEqual([2]);
    expect(calls).toEqual(["use:three"]);
  });

  it("Enter uses the selected row", () => {
    key("ArrowDown");
    const event = key("Enter");
    expect(calls).toEqual(["use:two"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { keys: ["ArrowDown"], expected: 1 },
    { keys: ["ArrowDown", "ArrowDown", "ArrowDown"], expected: 2 },
    { keys: ["End"], expected: 2 },
    { keys: ["End", "Home"], expected: 0 },
    { keys: ["ArrowUp"], expected: 0 },
    { keys: ["End", "ArrowUp"], expected: 1 },
  ])("keys $keys select row $expected", ({ keys, expected }) => {
    for (const k of keys) key(k);
    expect(selectedRows()).toEqual([expected]);
    expect(calls).toEqual([]);
  });

  it("Copy copies the current row", () => {
    key("ArrowDown");
    click(q("#alt-copy"));
    expect(calls).toEqual(["copy:two"]);
  });

  it.each([
    { name: "the Close button", close: () => click(q("#alt-close")) },
    { name: "the cross", close: () => click(q("#alt-x")) },
    { name: "Escape in the panel", close: () => key("Escape", q("#alt-copy")) },
  ])("$name asks to close", ({ close }) => {
    close();
    expect(calls).toEqual(["close"]);
  });

  it("shows alternatives as text, never as markup", () => {
    panel.showReady(["<b>bold</b> & <img src=x>"]);
    expect(rows()[0]?.textContent).toBe("<b>bold</b> & <img src=x>");
    expect(host.querySelector("b, img")).toBeNull();
    panel.showFailed("<script>alert(1)</script>");
    expect(host.querySelector("script")).toBeNull();
  });

  it("the list is a listbox of options with the selected one active", () => {
    expect(q("#alt-list").getAttribute("role")).toBe("listbox");
    expect(rows().every((r) => r.getAttribute("role") === "option")).toBe(true);
    expect(q("#alt-list").getAttribute("aria-activedescendant")).toBe("alt-row-0");
    key("ArrowDown");
    expect(q("#alt-list").getAttribute("aria-activedescendant")).toBe("alt-row-1");
  });
});
