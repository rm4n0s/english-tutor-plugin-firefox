import { describe, expect, it } from "vitest";
import { adjacentIssueId, issueAt } from "./navigation";

// Issues 1..4 at 0..4, 5..9, 10..14 and 20..24.
const ISSUES = [
  { id: 1, start: 0, end: 4 },
  { id: 2, start: 5, end: 9 },
  { id: 3, start: 10, end: 14 },
  { id: 4, start: 20, end: 24 },
];

describe("issueAt", () => {
  it.each([
    { caret: 0, expected: 1 },
    { caret: 3, expected: 1 },
    { caret: 4, expected: undefined }, // right after a word: outside
    { caret: 5, expected: 2 },
    { caret: 9, expected: undefined },
    { caret: 14, expected: undefined },
    { caret: 19, expected: undefined },
    { caret: 20, expected: 4 },
    { caret: 23, expected: 4 },
    { caret: 24, expected: undefined },
    { caret: 99, expected: undefined },
  ])("a caret at $caret is in $expected", ({ caret, expected }) => {
    expect(issueAt(ISSUES, caret)?.id).toBe(expected);
  });

  it("adjacent issues: the boundary belongs to the later one", () => {
    const touching = [
      { id: 1, start: 0, end: 4 },
      { id: 2, start: 4, end: 8 },
    ];
    expect(issueAt(touching, 4)?.id).toBe(2);
    expect(issueAt(touching, 3)?.id).toBe(1);
  });

  it("finds nothing in no issues", () => {
    expect(issueAt<(typeof ISSUES)[number]>([], 0)).toBeUndefined();
  });
});

describe("adjacentIssueId (F7 and Shift+F7)", () => {
  it.each([
    // From the selected issue.
    { name: "next from the first", selected: 1, caret: 0, dir: "next", expected: 2 },
    { name: "next from the middle", selected: 2, caret: 0, dir: "next", expected: 3 },
    {
      name: "next wraps from the last to the first",
      selected: 4,
      caret: 0,
      dir: "next",
      expected: 1,
    },
    { name: "previous from the middle", selected: 3, caret: 0, dir: "previous", expected: 2 },
    {
      name: "previous wraps from the first to the last",
      selected: 1,
      caret: 0,
      dir: "previous",
      expected: 4,
    },
    { name: "the selection wins over the caret", selected: 2, caret: 22, dir: "next", expected: 3 },
    // From the caret, with none selected.
    {
      name: "next from a caret before everything",
      selected: null,
      caret: 0,
      dir: "next",
      expected: 2,
    },
    { name: "next from a caret in a gap", selected: null, caret: 16, dir: "next", expected: 4 },
    {
      name: "next from a caret between two issues",
      selected: null,
      caret: 9,
      dir: "next",
      expected: 3,
    },
    {
      name: "next from a caret after the last wraps to the first",
      selected: null,
      caret: 30,
      dir: "next",
      expected: 1,
    },
    {
      name: "previous from a caret in a gap",
      selected: null,
      caret: 16,
      dir: "previous",
      expected: 3,
    },
    {
      name: "previous from a caret after the last",
      selected: null,
      caret: 30,
      dir: "previous",
      expected: 4,
    },
    {
      name: "previous from a caret before everything wraps to the last",
      selected: null,
      caret: 0,
      dir: "previous",
      expected: 4,
    },
    {
      name: "previous from the very start wraps",
      selected: null,
      caret: 0,
      dir: "previous",
      expected: 4,
    },
    {
      name: "an unknown selected id falls back to the caret",
      selected: 99,
      caret: 16,
      dir: "next",
      expected: 4,
    },
  ] as const)("$name", ({ selected, caret, dir, expected }) => {
    expect(adjacentIssueId(ISSUES, selected, caret, dir)).toBe(expected);
  });

  it("goes to the only issue, from anywhere, both ways", () => {
    const one = [{ id: 7, start: 3, end: 6 }];
    for (const [selected, caret] of [
      [7, 0],
      [null, 0],
      [null, 10],
    ] as const) {
      expect(adjacentIssueId(one, selected, caret, "next")).toBe(7);
      expect(adjacentIssueId(one, selected, caret, "previous")).toBe(7);
    }
  });

  it("goes nowhere when there are no issues", () => {
    expect(adjacentIssueId([], null, 0, "next")).toBeUndefined();
    expect(adjacentIssueId([], 3, 0, "previous")).toBeUndefined();
  });

  it("walking forward visits every issue once and returns to the start", () => {
    const seen: number[] = [];
    let selected: number | null = null;
    ISSUES.forEach(() => {
      selected = adjacentIssueId(ISSUES, selected, 0, "next") ?? null;
      seen.push(selected ?? -1);
    });
    expect(seen).toEqual([2, 3, 4, 1]);
    expect(adjacentIssueId(ISSUES, selected, 0, "next")).toBe(2);
  });
});
