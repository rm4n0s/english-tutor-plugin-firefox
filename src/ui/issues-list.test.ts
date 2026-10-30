// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueState } from "../core/issues";
import { fiveIssues, FIVE_TEXT, newState, placed } from "../core/issues/testing/helpers";
import { IssuesList, markerLetter, snippetPreview } from "./issues-list";

let state: IssueState;
let list: IssuesList;
let host: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
  state = newState().state;
  list = new IssuesList(document, host, state);
});

afterEach(() => {
  list.destroy();
});

const header = () => host.querySelector("#issues-header")?.textContent;
const rows = () => [...host.querySelectorAll<HTMLElement>(".issue-row")];
const emptyLine = () => host.querySelector(".empty")?.textContent;

function check(issues = fiveIssues(), text = FIVE_TEXT): void {
  state.beginCheck(true);
  state.finishCheck(issues, text, 0);
}

describe("snippetPreview", () => {
  it.each([
    { name: "a short snippet", snippet: "He go", expected: "He go" },
    { name: "white space runs", snippet: "He\n\n  go\tthere", expected: "He go there" },
    { name: "40 characters", snippet: "a".repeat(40), expected: "a".repeat(40) },
    { name: "41 characters", snippet: "a".repeat(41), expected: `${"a".repeat(40)}…` },
    {
      name: "a cut that ends in a space",
      snippet: `${"a".repeat(39)} bbbbb`,
      expected: `${"a".repeat(39)}…`,
    },
    { name: "emoji count as one", snippet: "😀".repeat(41), expected: `${"😀".repeat(40)}…` },
  ])("$name", ({ snippet, expected }) => {
    expect(snippetPreview(snippet)).toBe(expected);
  });
});

describe("markerLetter", () => {
  it.each([
    { category: "grammar", letter: "G" },
    { category: "vocabulary", letter: "V" },
    { category: "syntax", letter: "S" },
  ])("$category is $letter", ({ category, letter }) => {
    expect(markerLetter(category)).toBe(letter);
  });
});

describe("IssuesList", () => {
  it("shows Issues (0) and the first-check line before a check", () => {
    expect(header()).toBe("Issues (0)");
    expect(emptyLine()).toBe("Press Check to find errors");
    expect(host.querySelector("#issues")?.getAttribute("role")).toBe("listbox");
  });

  it("has one row per issue in text order with the marker, snippet, label and a badge slot", () => {
    check();
    expect(header()).toBe("Issues (5)");
    expect(
      rows().map((row) => [
        row.querySelector(".marker")?.textContent,
        row.querySelector(".row-snippet")?.textContent,
        row.querySelector(".row-label")?.textContent,
        row.dataset.category,
      ]),
    ).toEqual([
      ["G", "aaaa", "Verb form", "grammar"],
      ["G", "bbbb", "Article", "grammar"],
      ["V", "cccc", "Collocation", "vocabulary"],
      ["V", "dddd", "Spelling", "vocabulary"],
      ["S", "eeee", "Word order", "syntax"],
    ]);
    for (const row of rows()) {
      expect(row.getAttribute("role")).toBe("option");
      const badge = row.querySelector<HTMLElement>(".count-badge");
      expect(badge?.hidden).toBe(true);
    }
  });

  it.each([
    { name: "while checking", setup: () => state.beginCheck(true), expected: "Checking..." },
    {
      name: "after a check that found nothing",
      setup: () => {
        check([]);
      },
      expected: "No errors found",
    },
  ])("shows $expected $name", ({ setup, expected }) => {
    setup();
    expect(emptyLine()).toBe(expected);
    expect(rows()).toEqual([]);
  });

  it("cuts a long snippet", () => {
    const text = "x".repeat(60);
    check([placed(0, 60)], text);
    expect(rows()[0]?.querySelector(".row-snippet")?.textContent).toBe(`${"x".repeat(40)}…`);
  });

  it("hides the rows of a hidden category and says how many are shown", () => {
    check();
    state.setHidden("vocabulary", true);
    expect(header()).toBe("Issues (3 of 5 shown)");
    expect(rows().map((r) => r.querySelector(".row-snippet")?.textContent)).toEqual([
      "aaaa",
      "bbbb",
      "eeee",
    ]);
    state.setHidden("vocabulary", false);
    expect(header()).toBe("Issues (5)");
    expect(rows()).toHaveLength(5);
  });

  it("says so when every category is hidden", () => {
    check();
    for (const c of ["grammar", "vocabulary", "syntax"] as const) state.setHidden(c, true);
    expect(header()).toBe("Issues (0 of 5 shown)");
    expect(emptyLine()).toBe("All categories are hidden");
  });

  it("clicking a row selects its issue in the state, and the selected row is marked", () => {
    check();
    rows()[2]
      ?.querySelector(".row-snippet")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(state.selected?.snippet).toBe("cccc");
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  it("marks the row of an issue that the state selects", () => {
    check();
    state.select(state.issues[4]?.id ?? 0);
    expect(rows().map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);
    state.select(null);
    expect(rows().every((r) => r.getAttribute("aria-selected") === "false")).toBe(true);
  });

  describe("as a listbox", () => {
    const keydown = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      listbox().dispatchEvent(event);
      return event;
    };
    const listbox = () => host.querySelector<HTMLElement>("#issues")!;
    const selected = () => state.selected?.snippet;

    it("is one tab stop, vertical, labelled by its header, and its rows have unique ids", () => {
      check();
      expect(listbox().getAttribute("tabindex")).toBe("0");
      expect(listbox().getAttribute("aria-orientation")).toBe("vertical");
      expect(listbox().getAttribute("aria-labelledby")).toBe("issues-header");
      expect(new Set(rows().map((r) => r.id)).size).toBe(5);
      expect(rows().every((r) => r.getAttribute("role") === "option")).toBe(true);
    });

    it("names the selected row as the active descendant, and none when nothing is selected", () => {
      check();
      expect(listbox().hasAttribute("aria-activedescendant")).toBe(false);
      state.select(state.issues[3]?.id ?? 0);
      expect(listbox().getAttribute("aria-activedescendant")).toBe(rows()[3]?.id);
      state.select(null);
      expect(listbox().hasAttribute("aria-activedescendant")).toBe(false);
    });

    it("drops the active descendant when the rows go", () => {
      check();
      state.select(state.issues[0]?.id ?? 0);
      state.reset();
      expect(listbox().hasAttribute("aria-activedescendant")).toBe(false);
    });

    it.each([
      { name: "Down from nothing selects the first", keys: ["ArrowDown"], expected: "aaaa" },
      { name: "Up from nothing selects the last", keys: ["ArrowUp"], expected: "eeee" },
      { name: "Down moves on", keys: ["ArrowDown", "ArrowDown", "ArrowDown"], expected: "cccc" },
      { name: "Up moves back", keys: ["End", "ArrowUp"], expected: "dddd" },
      {
        name: "Down stops at the last row",
        keys: ["End", "ArrowDown", "ArrowDown"],
        expected: "eeee",
      },
      { name: "Up stops at the first row", keys: ["Home", "ArrowUp"], expected: "aaaa" },
      { name: "Home", keys: ["End", "Home"], expected: "aaaa" },
      { name: "End", keys: ["End"], expected: "eeee" },
    ])("$name", ({ keys, expected }) => {
      check();
      for (const key of keys) expect(keydown(key).defaultPrevented).toBe(true);
      expect(selected()).toBe(expected);
    });

    it("skips rows of a hidden category", () => {
      check();
      state.setHidden("vocabulary", true);
      keydown("End");
      keydown("ArrowUp");
      expect(selected()).toBe("bbbb");
    });

    it("leaves other keys, and shortcuts with a modifier, alone", () => {
      check();
      for (const event of [
        keydown("a"),
        keydown("Tab"),
        keydown("ArrowDown", { ctrlKey: true }),
        keydown("ArrowDown", { altKey: true }),
      ]) {
        expect(event.defaultPrevented).toBe(false);
      }
      expect(state.selectedId).toBeNull();
    });

    it("does nothing with no rows", () => {
      expect(keydown("ArrowDown").defaultPrevented).toBe(true);
      expect(state.selectedId).toBeNull();
    });

    it("Enter and a double click activate the selected issue; Enter with none does nothing", () => {
      const activated: number[] = [];
      list.destroy();
      list = new IssuesList(document, host, state, { onActivate: (id) => activated.push(id) });
      check();
      expect(keydown("Enter").defaultPrevented).toBe(false);
      expect(activated).toEqual([]);
      const id = state.issues[1]?.id ?? 0;
      state.select(id);
      expect(keydown("Enter").defaultPrevented).toBe(true);
      expect(activated).toEqual([id]);
      const third = state.issues[2]?.id ?? 0;
      rows()[2]
        ?.querySelector(".row-snippet")
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(state.selectedId).toBe(third);
      expect(activated).toEqual([id, third]);
    });

    it("scrolls the selected row into view, whoever selected it", () => {
      check();
      const box = listbox();
      Object.defineProperty(box, "clientHeight", { value: 100, configurable: true });
      box.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
      rows().forEach((row, i) => {
        row.getBoundingClientRect = () => new DOMRect(0, i * 60 - box.scrollTop, 200, 50);
      });
      state.select(state.issues[4]?.id ?? 0);
      // The row spans 240..290 and the view is 100 high: scrolled so that its bottom is the view's.
      expect(box.scrollTop).toBe(190);
      state.select(state.issues[0]?.id ?? 0);
      expect(box.scrollTop).toBe(0);
    });
  });

  it("drops its rows when the issues go", () => {
    check();
    state.reset();
    expect(rows()).toEqual([]);
    expect(header()).toBe("Issues (0)");
    expect(emptyLine()).toBe("Press Check to find errors");
  });

  it("builds rows with text nodes only, even for a snippet that looks like markup", () => {
    const text = "<img src=x onerror=alert(1)>";
    check([placed(0, text.length)], text);
    expect(host.querySelector("img")).toBeNull();
    expect(rows()[0]?.querySelector(".row-snippet")?.textContent).toBe(text);
  });

  it("stops listening after destroy", () => {
    list.destroy();
    check();
    expect(rows()).toEqual([]);
  });
});
