import { describe, expect, it } from "vitest";
import type { TypeStats } from "../store/types";
import {
  DEFAULT_SORT,
  formatDate,
  naturalDirection,
  nextSort,
  sortRows,
  summaryText,
  toRows,
  visibleRows,
  type SortColumn,
  type StatRow,
} from "./stats-table";
import { usageCellText } from "./usage-table";

const stat = (
  error_type: string,
  total: number,
  last30: number,
  last7: number,
  last_seen: number,
  category = "grammar",
): TypeStats => ({ error_type, category, total, last30, last7, last_seen });

const ROWS = toRows([
  stat("article", 10, 4, 2, 300),
  stat("verb_tense", 10, 1, 0, 100),
  stat("wrong_word", 5, 5, 3, 200, "vocabulary"),
  stat("word_order", 1, 0, 0, 50, "syntax"),
]);

const labels = (rows: readonly StatRow[]) => rows.map((r) => r.label);

describe("toRows", () => {
  it("adds the labels of the taxonomy", () => {
    expect(ROWS[0]).toEqual({
      errorType: "article",
      label: "Article",
      category: "grammar",
      categoryLabel: "Grammar",
      total: 10,
      last30: 4,
      last7: 2,
      lastSeen: 300,
    });
  });

  it("keeps the id and the stored category of a type the taxonomy does not know", () => {
    const [row] = toRows([stat("old_type", 2, 2, 2, 1, "grammar")]);
    expect(row).toMatchObject({ label: "old_type", category: "grammar", categoryLabel: "Grammar" });
  });
});

describe("sortRows", () => {
  it.each([
    {
      name: "Total, highest first (the default), ties by label",
      sort: DEFAULT_SORT,
      expected: ["Article", "Verb tense", "Wrong word", "Word order"],
    },
    {
      name: "Total reversed: lowest first, ties still by label A first",
      sort: { column: "total", direction: "asc" } as const,
      expected: ["Word order", "Wrong word", "Article", "Verb tense"],
    },
    {
      name: "Error type A to Z",
      sort: { column: "type", direction: "asc" } as const,
      expected: ["Article", "Verb tense", "Word order", "Wrong word"],
    },
    {
      name: "Error type Z to A",
      sort: { column: "type", direction: "desc" } as const,
      expected: ["Wrong word", "Word order", "Verb tense", "Article"],
    },
    {
      name: "Category A to Z, ties by label",
      sort: { column: "category", direction: "asc" } as const,
      expected: ["Article", "Verb tense", "Word order", "Wrong word"],
    },
    {
      name: "Last 7 days, most first",
      sort: { column: "last7", direction: "desc" } as const,
      expected: ["Wrong word", "Article", "Verb tense", "Word order"],
    },
    {
      name: "Last 30 days, most first",
      sort: { column: "last30", direction: "desc" } as const,
      expected: ["Wrong word", "Article", "Verb tense", "Word order"],
    },
    {
      name: "Last seen, newest first",
      sort: { column: "seen", direction: "desc" } as const,
      expected: ["Article", "Wrong word", "Verb tense", "Word order"],
    },
    {
      name: "Last seen, oldest first",
      sort: { column: "seen", direction: "asc" } as const,
      expected: ["Word order", "Verb tense", "Wrong word", "Article"],
    },
  ])("$name", ({ sort, expected }) => {
    expect(labels(sortRows(ROWS, sort))).toEqual(expected);
  });

  it("does not change the rows it is given", () => {
    const before = labels(ROWS);
    sortRows(ROWS, { column: "type", direction: "desc" });
    expect(labels(ROWS)).toEqual(before);
  });
});

describe("nextSort (a click on a header)", () => {
  it.each<{ column: SortColumn; natural: "asc" | "desc" }>([
    { column: "type", natural: "asc" },
    { column: "category", natural: "asc" },
    { column: "total", natural: "desc" },
    { column: "last7", natural: "desc" },
    { column: "last30", natural: "desc" },
    { column: "seen", natural: "desc" },
  ])("$column starts $natural and reverses on a second click", ({ column, natural }) => {
    expect(naturalDirection(column)).toBe(natural);
    const other: SortColumn = column === "type" ? "total" : "type";
    const first = nextSort({ column: other, direction: "asc" }, column);
    expect(first).toEqual({ column, direction: natural });
    const second = nextSort(first, column);
    expect(second).toEqual({ column, direction: natural === "asc" ? "desc" : "asc" });
    expect(nextSort(second, column)).toEqual(first);
  });

  it("the default table is Total, highest first, and a click on Total reverses it", () => {
    expect(DEFAULT_SORT).toEqual({ column: "total", direction: "desc" });
    expect(nextSort(DEFAULT_SORT, "total").direction).toBe("asc");
  });
});

describe("visibleRows", () => {
  it.each([
    {
      name: "all time shows every type",
      filter: { period: "all" } as const,
      expected: ["Article", "Verb tense", "Word order", "Wrong word"],
    },
    {
      name: "30 days hides the type with none in 30 days",
      filter: { period: "30d" } as const,
      expected: ["Article", "Verb tense", "Wrong word"],
    },
    {
      name: "7 days hides the types with none in 7 days",
      filter: { period: "7d" } as const,
      expected: ["Article", "Wrong word"],
    },
    {
      name: "a category",
      filter: { period: "all", category: "grammar" } as const,
      expected: ["Article", "Verb tense"],
    },
    {
      name: "a category and a period",
      filter: { period: "7d", category: "vocabulary" } as const,
      expected: ["Wrong word"],
    },
    {
      name: "a category without mistakes in the period",
      filter: { period: "7d", category: "syntax" } as const,
      expected: [],
    },
  ])("$name", ({ filter, expected }) => {
    expect(labels(visibleRows(ROWS, filter)).sort()).toEqual([...expected].sort());
  });
});

describe("summaryText", () => {
  const summary = (filter: Parameters<typeof visibleRows>[1]) =>
    summaryText(visibleRows(ROWS, filter), filter);

  it.each([
    {
      name: "all time",
      filter: { period: "all" } as const,
      expected: "26 mistakes in all time. Most frequent: Article.",
    },
    {
      name: "30 days",
      filter: { period: "30d" } as const,
      expected: "10 mistakes in the last 30 days. Most frequent: Wrong word.",
    },
    {
      name: "7 days",
      filter: { period: "7d" } as const,
      expected: "5 mistakes in the last 7 days. Most frequent: Wrong word.",
    },
    {
      name: "a category",
      filter: { period: "all", category: "grammar" } as const,
      expected: "20 mistakes in all time (Grammar). Most frequent: Article.",
    },
    {
      name: "a category and no mistakes in the period",
      filter: { period: "7d", category: "syntax" } as const,
      expected: "No mistakes in the last 7 days (Syntax).",
    },
  ])("$name", ({ filter, expected }) => {
    expect(summary(filter)).toBe(expected);
  });

  it("breaks a tie by label, and says one mistake in the singular", () => {
    expect(summary({ period: "all", category: "grammar" })).toContain("Most frequent: Article");
    const one = toRows([stat("article", 1, 1, 1, 1)]);
    expect(summaryText(one, { period: "all" })).toBe(
      "1 mistake in all time. Most frequent: Article.",
    );
  });

  it("says so when nothing is recorded", () => {
    expect(summaryText([], { period: "all" })).toBe("No mistakes recorded yet.");
    expect(summaryText([], { period: "30d" })).toBe("No mistakes in the last 30 days.");
  });
});

describe("formatDate", () => {
  it("writes the local date as year-month-day with two digits", () => {
    expect(formatDate(new Date(2026, 2, 5, 12, 30).getTime())).toBe("2026-03-05");
    expect(formatDate(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31");
  });
});

describe("usageCellText", () => {
  it.each([
    {
      sums: { input_tokens: 812, output_tokens: 164, estimated: false },
      expected: "812 in / 164 out",
    },
    {
      sums: { input_tokens: 5200, output_tokens: 1100, estimated: false },
      expected: "5.2k in / 1.1k out",
    },
    {
      sums: { input_tokens: 812, output_tokens: 164, estimated: true },
      expected: "~812 in / ~164 out",
    },
    { sums: { input_tokens: 0, output_tokens: 0, estimated: false }, expected: "0 in / 0 out" },
  ])("$expected", ({ sums, expected }) => {
    expect(usageCellText(sums)).toBe(expected);
  });
});
