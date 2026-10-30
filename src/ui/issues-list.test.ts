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
