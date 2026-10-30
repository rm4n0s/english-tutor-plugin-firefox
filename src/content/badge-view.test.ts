import { describe, expect, it } from "vitest";
import type { BoxStatus, WireIssue } from "../core/page-mode/protocol";
import { badgeViewOf, dominantCategory } from "./badge-view";

const issues = (...categories: WireIssue["category"][]): WireIssue[] =>
  categories.map((category, i) => ({ id: i + 1, start: i * 10, end: i * 10 + 5, category }));

const box = (status: BoxStatus, list: WireIssue[] = [], message?: string) => ({
  status,
  issues: list,
  message,
});

describe("dominantCategory", () => {
  it.each([
    { name: "none", list: [], expected: undefined },
    { name: "one", list: ["vocabulary"], expected: "vocabulary" },
    {
      name: "the most numerous",
      list: ["grammar", "syntax", "syntax", "vocabulary"],
      expected: "syntax",
    },
    { name: "a tie goes to legend order", list: ["vocabulary", "grammar"], expected: "grammar" },
    { name: "a three-way tie", list: ["vocabulary", "syntax", "grammar"], expected: "grammar" },
  ] as const)("$name", ({ list, expected }) => {
    expect(dominantCategory(issues(...list))).toBe(expected);
  });
});

describe("badgeViewOf: the states of the badge (SPEC section 4.11)", () => {
  it.each([
    { name: "the icon before the first check", box: box("idle"), kind: "icon" },
    { name: "a spinner while checking", box: box("checking"), kind: "spinner" },
    {
      name: "a spinner while re-checking, issues of the last check or not",
      box: box("checking", issues("grammar")),
      kind: "spinner",
    },
    { name: "a check mark when nothing was found", box: box("checked"), kind: "check" },
    {
      name: "the count when there are issues",
      box: box("checked", issues("grammar", "grammar")),
      kind: "count",
    },
    {
      name: "the count for issues left after an edit",
      box: box("idle", issues("syntax")),
      kind: "count",
    },
    { name: "! after a failure", box: box("failed", [], "It failed"), kind: "warning" },
    { name: "! with no LLM", box: box("no-llm", [], "No LLM"), kind: "warning" },
    {
      name: "! for a text that is too long",
      box: box("too-long", [], "Too long"),
      kind: "warning",
    },
  ] as const)("$name", ({ box: b, kind }) => {
    expect(badgeViewOf(b).kind).toBe(kind);
  });

  it("counts the issues, in the colour of the category with the most, with a tooltip that says so", () => {
    const view = badgeViewOf(box("checked", issues("vocabulary", "grammar", "grammar")));
    expect(view).toEqual({
      kind: "count",
      count: 3,
      category: "grammar",
      label: "3 issues (2 grammar, 1 vocabulary)",
    });
  });

  it("says issue in the singular", () => {
    expect(badgeViewOf(box("checked", issues("syntax"))).label).toBe("1 issue (1 syntax)");
  });

  it.each([
    { status: "failed", message: "The request to the LLM failed." },
    { status: "no-llm", message: "No LLM is configured." },
    { status: "too-long", message: "More than 10,000 words." },
  ] as const)("the tooltip of $status is the frame's message", ({ status, message }) => {
    expect(badgeViewOf(box(status, [], message)).label).toBe(message);
  });

  it("has a tooltip for a warning without a message", () => {
    expect(badgeViewOf(box("failed")).label).toBe("English Tutor could not check this text");
  });

  it("shows ! with the blocked message whatever the box says", () => {
    expect(badgeViewOf(box("checked", issues("grammar")), "Blocked")).toEqual({
      kind: "warning",
      label: "Blocked",
    });
  });
});
