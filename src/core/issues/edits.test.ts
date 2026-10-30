import { describe, expect, it } from "vitest";
import {
  diffText,
  EditLog,
  rebaseIssues,
  rebaseRange,
  rebaseRangeAcross,
  touches,
  type Edit,
} from "./edits";

describe("diffText", () => {
  it.each([
    { name: "equal texts", old: "abc", next: "abc", edit: undefined },
    { name: "an insertion in the middle", old: "abcdef", next: "abcXYdef", edit: [3, 0, 2] },
    { name: "an insertion at the start", old: "abc", next: "Xabc", edit: [0, 0, 1] },
    { name: "an insertion at the end", old: "abc", next: "abcX", edit: [3, 0, 1] },
    { name: "a deletion", old: "abcdef", next: "abef", edit: [2, 2, 0] },
    { name: "a replacement", old: "abcdef", next: "abXYZef", edit: [2, 2, 3] },
    { name: "all text replaced", old: "abc", next: "xyz", edit: [0, 3, 3] },
    { name: "from empty", old: "", next: "abc", edit: [0, 0, 3] },
    { name: "to empty", old: "abc", next: "", edit: [0, 3, 0] },
    {
      // Typing "a" in "aa" is the same as typing it anywhere in the run: the prefix wins.
      name: "an insertion next to equal characters takes the longest prefix",
      old: "aa",
      next: "aaa",
      edit: [2, 0, 1],
    },
    {
      name: "a deletion in a run takes the longest prefix",
      old: "aaa",
      next: "aa",
      edit: [2, 1, 0],
    },
    {
      name: "one emoji replaced by another keeps the pair whole",
      old: "a😀b",
      next: "a😁b",
      edit: [1, 2, 2],
    },
    {
      name: "an emoji inserted before another keeps the pair whole",
      old: "a😀",
      next: "a😁😀",
      edit: [1, 0, 2],
    },
    {
      name: "an emoji added after an emoji",
      old: "😀",
      next: "😀😀",
      edit: [2, 0, 2],
    },
    {
      name: "an emoji deleted from two",
      old: "😀😁",
      next: "😁",
      edit: [0, 2, 0],
    },
  ])("$name", ({ old, next, edit }) => {
    const found = diffText(old, next);
    if (edit === undefined) {
      expect(found).toBeUndefined();
      return;
    }
    expect(found).toEqual({ start: edit[0], removed: edit[1], added: edit[2] });
    // Applying the edit to the old text gives the new text.
    const e = found!;
    expect(
      old.slice(0, e.start) +
        next.slice(e.start, e.start + e.added) +
        old.slice(e.start + e.removed),
    ).toBe(next);
  });

  it("never splits a surrogate pair, for random edits of a text with emoji", () => {
    const alphabet = ["a", "b", "😀", "😁", " ", "é"];
    let seed = 12345;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const make = (): string =>
      Array.from({ length: random(8) }, () => alphabet[random(alphabet.length)]).join("");
    for (let i = 0; i < 2000; i++) {
      const old = make();
      const next = make();
      const edit = diffText(old, next);
      if (edit === undefined) continue;
      const end = edit.start + edit.removed;
      const newEnd = edit.start + edit.added;
      for (const [text, at] of [
        [old, edit.start],
        [old, end],
        [next, edit.start],
        [next, newEnd],
      ] as const) {
        const high = text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff;
        const low = text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;
        expect(high && low, `${old} -> ${next} at ${String(at)}`).toBe(false);
      }
      expect(old.slice(0, edit.start) + next.slice(edit.start, newEnd) + old.slice(end)).toBe(next);
    }
  });
});

// The issue is at 10..20 in every row below.
const ISSUE = { start: 10, end: 20 };

describe("rebaseRange (SPEC section 5.5)", () => {
  it.each([
    // Before the issue: shift by the net length change.
    { name: "an insertion well before", edit: [2, 0, 3], expected: [13, 23] },
    { name: "a deletion well before", edit: [2, 3, 0], expected: [7, 17] },
    { name: "a replacement before that grows", edit: [0, 2, 5], expected: [13, 23] },
    { name: "a replacement before that shrinks", edit: [0, 5, 2], expected: [7, 17] },
    { name: "a replacement before that keeps the length", edit: [0, 5, 5], expected: [10, 20] },
    { name: "an edit that ends one unit before the start", edit: [5, 4, 9], expected: [15, 25] },
    { name: "an insertion one unit before the start", edit: [9, 0, 1], expected: [11, 21] },
    // Touching: removed.
    {
      name: "an edit that ends exactly at the start (adjacent before)",
      edit: [5, 5, 1],
      expected: null,
    },
    { name: "an insertion exactly at the start", edit: [10, 0, 1], expected: null },
    { name: "a deletion that ends at the start", edit: [8, 2, 0], expected: null },
    { name: "an edit inside", edit: [14, 0, 1], expected: null },
    { name: "a deletion inside", edit: [12, 3, 0], expected: null },
    { name: "an edit that covers the whole issue", edit: [5, 20, 3], expected: null },
    { name: "an edit that starts inside and ends after", edit: [15, 10, 1], expected: null },
    { name: "an edit that starts before and ends inside", edit: [8, 5, 1], expected: null },
    { name: "an insertion exactly at the end (adjacent after)", edit: [20, 0, 1], expected: null },
    { name: "an edit that starts exactly at the end", edit: [20, 4, 0], expected: null },
    // After: left alone.
    { name: "an insertion one unit after the end", edit: [21, 0, 1], expected: [10, 20] },
    { name: "a deletion well after", edit: [30, 5, 0], expected: [10, 20] },
    { name: "a replacement after", edit: [25, 2, 9], expected: [10, 20] },
  ] as const satisfies readonly {
    name: string;
    edit: readonly number[];
    expected: readonly number[] | null;
  }[])("$name", ({ edit, expected }) => {
    const result = rebaseRange(ISSUE, { start: edit[0], removed: edit[1], added: edit[2] });
    expect(result === null ? null : [result.start, result.end]).toEqual(expected);
  });

  it("touches is the same test", () => {
    expect(touches(ISSUE, { start: 20, removed: 0, added: 1 })).toBe(true);
    expect(touches(ISSUE, { start: 21, removed: 0, added: 1 })).toBe(false);
    expect(touches(ISSUE, { start: 5, removed: 5, added: 0 })).toBe(true);
    expect(touches(ISSUE, { start: 5, removed: 4, added: 0 })).toBe(false);
  });
});

describe("rebaseIssues", () => {
  const issues = [
    { id: 1, start: 0, end: 4 },
    { id: 2, start: 10, end: 15 },
    { id: 3, start: 20, end: 25 },
    { id: 4, start: 30, end: 33 },
  ];

  it.each([
    {
      name: "an edit inside one issue: it goes, later ones move, earlier ones stay",
      edit: { start: 12, removed: 0, added: 4 },
      expected: [
        [1, 0, 4],
        [3, 24, 29],
        [4, 34, 37],
      ],
    },
    {
      name: "an edit between two issues moves only the later ones",
      edit: { start: 17, removed: 0, added: 2 },
      expected: [
        [1, 0, 4],
        [2, 10, 15],
        [3, 22, 27],
        [4, 32, 35],
      ],
    },
    {
      name: "a deletion that spans two issues removes both",
      edit: { start: 12, removed: 10, added: 0 },
      expected: [
        [1, 0, 4],
        [4, 20, 23],
      ],
    },
    {
      name: "an insertion at offset 0 touches the first issue (adjacent at its start)",
      edit: { start: 0, removed: 0, added: 3 },
      expected: [
        [2, 13, 18],
        [3, 23, 28],
        [4, 33, 36],
      ],
    },
    {
      name: "an insertion one unit after the first issue ends leaves it, and moves the others",
      edit: { start: 5, removed: 0, added: 3 },
      expected: [
        [1, 0, 4],
        [2, 13, 18],
        [3, 23, 28],
        [4, 33, 36],
      ],
    },
    {
      name: "an edit at the end of the text leaves all alone",
      edit: { start: 40, removed: 0, added: 5 },
      expected: [
        [1, 0, 4],
        [2, 10, 15],
        [3, 20, 25],
        [4, 30, 33],
      ],
    },
  ])("$name", ({ edit, expected }) => {
    const result = rebaseIssues(issues, edit).map((i) => [i.id, i.start, i.end]);
    expect(result).toEqual(expected);
  });

  it("keeps the objects that do not move, and keeps extra fields on the ones that do", () => {
    const withData = [
      { id: 1, start: 0, end: 4, note: "a" },
      { id: 2, start: 10, end: 15, note: "b" },
    ];
    const result = rebaseIssues(withData, { start: 6, removed: 0, added: 1 });
    expect(result[0]).toBe(withData[0]);
    expect(result[1]).toEqual({ id: 2, start: 11, end: 16, note: "b" });
    expect(withData[1]).toEqual({ id: 2, start: 10, end: 15, note: "b" });
  });
});

describe("rebaseRangeAcross", () => {
  it.each([
    {
      name: "no edits",
      edits: [],
      expected: [10, 20],
    },
    {
      name: "two edits before, in order",
      edits: [
        { start: 0, removed: 0, added: 5 },
        { start: 2, removed: 3, added: 0 },
      ],
      expected: [12, 22],
    },
    {
      name: "an edit that moves the range onto a later one",
      // After the first edit the range is at 15..25; the second touches it.
      edits: [
        { start: 0, removed: 0, added: 5 },
        { start: 24, removed: 1, added: 1 },
      ],
      expected: null,
    },
    {
      name: "an edit after, then one before",
      edits: [
        { start: 40, removed: 0, added: 5 },
        { start: 1, removed: 1, added: 3 },
      ],
      expected: [12, 22],
    },
  ])("$name", ({ edits, expected }) => {
    const result = rebaseRangeAcross(ISSUE, edits);
    expect(result === null ? null : [result.start, result.end]).toEqual(expected);
  });
});

describe("EditLog", () => {
  const edit = (start: number): Edit => ({ start, removed: 0, added: 1 });

  it("keeps edits in order and starts again on clear", () => {
    const log = new EditLog();
    log.push(edit(1));
    log.push(edit(2));
    expect(log.edits).toEqual([edit(1), edit(2)]);
    expect(log.size).toBe(2);
    log.clear();
    expect(log.edits).toEqual([]);
  });

  it.each([
    { limit: 3, pushes: 3, overflowed: false },
    { limit: 3, pushes: 4, overflowed: true },
    { limit: 3, pushes: 50, overflowed: true },
    { limit: 0, pushes: 1, overflowed: true },
  ])(
    "with a limit of $limit, $pushes edits overflow: $overflowed",
    ({ limit, pushes, overflowed }) => {
      const log = new EditLog(limit);
      for (let i = 0; i < pushes; i++) log.push(edit(i));
      expect(log.overflowed).toBe(overflowed);
      expect(log.edits === undefined).toBe(overflowed);
    },
  );

  it("stays overflowed until it is cleared", () => {
    const log = new EditLog(1);
    log.push(edit(0));
    log.push(edit(1));
    log.push(edit(2));
    expect(log.edits).toBeUndefined();
    log.clear();
    log.push(edit(3));
    expect(log.edits).toEqual([edit(3)]);
  });

  it("is unusable after invalidate", () => {
    const log = new EditLog();
    log.push(edit(0));
    log.invalidate();
    expect(log.overflowed).toBe(true);
    expect(log.edits).toBeUndefined();
  });

  it("holds 100,000 edits by default and overflows at the next", () => {
    const log = new EditLog();
    for (let i = 0; i < 100_000; i++) log.push(edit(i));
    expect(log.overflowed).toBe(false);
    log.push(edit(0));
    expect(log.overflowed).toBe(true);
  });
});

describe("an edit that empties or replaces the whole text (SPEC section 4.11: a page clears its box)", () => {
  const TEXT = "Yesterday I seen him. He go home.";
  // "I seen" is 10..16, "He go" is 22..27, and one issue sits at the very end of the text.
  const issues = [
    { id: 1, start: 10, end: 16 },
    { id: 2, start: 22, end: 27 },
    { id: 3, start: 28, end: TEXT.length },
  ];

  it.each([
    { name: "emptied", next: "" },
    { name: "replaced by a text with nothing in common", next: "Xyz qw" },
    { name: "replaced by a text with the same first letter", next: "Y! 1" },
    { name: "replaced by a text that ends with the same period", next: "Z. ." },
    { name: "emptied but for one character", next: "." },
    { name: "emptied but for a space", next: " " },
  ])("$name: no issue is left", ({ next }) => {
    const edit = diffText(TEXT, next);
    expect(edit).toBeDefined();
    expect(rebaseIssues(issues, edit!)).toEqual([]);
  });

  it.each([
    { name: "emptied", next: "", expected: { start: 0, removed: TEXT.length, added: 0 } },
    {
      name: "replaced, same length, nothing in common",
      next: "x".repeat(TEXT.length),
      expected: { start: 0, removed: TEXT.length, added: TEXT.length },
    },
  ])("$name: the edit covers the whole old text", ({ next, expected }) => {
    expect(diffText(TEXT, next)).toEqual(expected);
  });

  it("an empty text emptied again is not an edit", () => {
    expect(diffText("", "")).toBeUndefined();
  });

  it("a text that grows back from empty leaves no issue to move", () => {
    expect(rebaseIssues([], diffText("", TEXT)!)).toEqual([]);
  });
});
