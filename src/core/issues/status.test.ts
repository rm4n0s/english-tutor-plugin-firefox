import { describe, expect, it } from "vitest";
import type { IssueState } from "./state";
import { checkStatusText, issuesEmptyText, issuesHeaderText, wordCountText } from "./status";
import { fiveIssues, FIVE_TEXT, newState, placed } from "./testing/helpers";

type Setup = (state: IssueState) => void;

const finish =
  (issues = fiveIssues(), unplaced = 0): Setup =>
  (state) => {
    state.beginCheck(true);
    state.finishCheck(issues, FIVE_TEXT, unplaced);
  };

describe("checkStatusText", () => {
  it.each<{ name: string; setup: Setup; expected: string }>([
    { name: "a new text", setup: () => undefined, expected: "Ready" },
    {
      name: "a running check",
      setup: (s) => {
        s.beginCheck(true);
      },
      expected: "Checking...",
    },
    {
      name: "a running auto-check",
      setup: (s) => {
        s.beginCheck(false);
      },
      expected: "Checking...",
    },
    { name: "five issues", setup: finish(), expected: "5 issues" },
    { name: "one issue", setup: finish([placed(0, 4)]), expected: "1 issue" },
    { name: "no issues", setup: finish([]), expected: "No errors found" },
    {
      name: "issues and one that was not placed",
      setup: finish(fiveIssues(), 1),
      expected: "5 issues · 1 issue could not be placed",
    },
    {
      name: "issues and three that were not placed",
      setup: finish(fiveIssues(), 3),
      expected: "5 issues · 3 issues could not be placed",
    },
    {
      name: "no errors and two not placed",
      setup: finish([], 2),
      expected: "No errors found · 2 issues could not be placed",
    },
    {
      name: "a cancelled check",
      setup: (s) => {
        finish()(s);
        s.beginCheck(true);
        s.endCheck("cancelled");
      },
      expected: "Check cancelled",
    },
    {
      name: "a failed check",
      setup: (s) => {
        s.beginCheck(true);
        s.endCheck("failed");
      },
      expected: "Check failed",
    },
    {
      name: "a new check after a result",
      setup: (s) => {
        finish()(s);
        s.beginCheck(true);
      },
      expected: "Checking...",
    },
    {
      name: "a text that was edited after a result",
      setup: (s) => {
        finish()(s);
        s.reset();
      },
      expected: "Ready",
    },
  ])("$name: $expected", ({ setup, expected }) => {
    const { state } = newState();
    setup(state);
    expect(checkStatusText(state)).toBe(expected);
  });
});

describe("wordCountText", () => {
  it.each([
    { n: 0, expected: "0 words" },
    { n: 1, expected: "1 word" },
    { n: 142, expected: "142 words" },
  ])("$n is $expected", ({ n, expected }) => {
    expect(wordCountText(n)).toBe(expected);
  });
});

describe("issuesHeaderText", () => {
  it.each<{ name: string; setup: Setup; expected: string }>([
    { name: "before a check", setup: () => undefined, expected: "Issues (0)" },
    { name: "five issues", setup: finish(), expected: "Issues (5)" },
    {
      name: "a category without issues hidden",
      setup: (s) => {
        finish([placed(0, 4)])(s);
        s.setHidden("syntax", true);
      },
      expected: "Issues (1)",
    },
    {
      name: "vocabulary hidden",
      setup: (s) => {
        finish()(s);
        s.setHidden("vocabulary", true);
      },
      expected: "Issues (3 of 5 shown)",
    },
    {
      name: "everything hidden",
      setup: (s) => {
        finish()(s);
        for (const c of ["grammar", "vocabulary", "syntax"] as const) s.setHidden(c, true);
      },
      expected: "Issues (0 of 5 shown)",
    },
  ])("$name: $expected", ({ setup, expected }) => {
    const { state } = newState();
    setup(state);
    expect(issuesHeaderText(state)).toBe(expected);
  });
});

describe("issuesEmptyText", () => {
  it.each<{ name: string; setup: Setup; expected: string | undefined }>([
    {
      name: "before the first check",
      setup: () => undefined,
      expected: "Press Check to find errors",
    },
    {
      name: "while the first check runs",
      setup: (s) => {
        s.beginCheck(true);
      },
      expected: "Checking...",
    },
    { name: "a check that found nothing", setup: finish([]), expected: "No errors found" },
    { name: "rows to show", setup: finish(), expected: undefined },
    {
      name: "all rows hidden",
      setup: (s) => {
        finish()(s);
        for (const c of ["grammar", "vocabulary", "syntax"] as const) s.setHidden(c, true);
      },
      expected: "All categories are hidden",
    },
    {
      name: "a first check that failed",
      setup: (s) => {
        s.beginCheck(true);
        s.endCheck("failed");
      },
      expected: "Press Check to find errors",
    },
    {
      name: "a later check of an empty result",
      setup: (s) => {
        finish([])(s);
        s.beginCheck(true);
      },
      expected: "Checking...",
    },
  ])("$name", ({ setup, expected }) => {
    const { state } = newState();
    setup(state);
    expect(issuesEmptyText(state)).toBe(expected);
  });
});
