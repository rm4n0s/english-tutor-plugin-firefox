import { describe, expect, it } from "vitest";
import { appendLocated, EMPTY_LOCATE_RESULT, locate, occurrences } from "./locate";
import type { Issue } from "./parse";
import { resolveErrorType } from "./taxonomy";

function issue(text: string, contextBefore = "", contextAfter = ""): Issue {
  return { text, type: resolveErrorType("article"), message: "m", contextBefore, contextAfter };
}

describe("locate", () => {
  it.each([
    {
      name: "single occurrence",
      text: "Yesterday he go to school.",
      issues: [issue("he go")],
      spans: [[10, 15]],
    },
    {
      name: "context picks the second of two",
      text: "I has a cat. You has a dog.",
      issues: [issue("has", "You ", " a dog")],
      spans: [[17, 20]],
    },
    {
      name: "context picks the first of two",
      text: "I has a cat. You has a dog.",
      issues: [issue("has", "", " a cat")],
      spans: [[2, 5]],
    },
    {
      name: "context with trimmed white space still matches",
      text: "I has a cat. You has a dog.",
      issues: [issue("has", "You", "a dog.")],
      spans: [[17, 20]],
    },
    {
      name: "context beyond the match does not matter, a partial match counts",
      text: "I has a cat. You has a dog.",
      issues: [issue("has", "xx You", " a dog and more")],
      spans: [[17, 20]],
    },
    {
      name: "tie goes to the first unclaimed, one issue per occurrence",
      text: "teh cat and teh dog",
      issues: [issue("teh"), issue("teh")],
      spans: [
        [0, 3],
        [12, 15],
      ],
    },
    {
      name: "more reports than occurrences: the extra overlaps",
      text: "teh cat and teh dog",
      issues: [issue("teh"), issue("teh"), issue("teh")],
      spans: [
        [0, 3],
        [12, 15],
      ],
      overlapping: 1,
    },
    {
      name: "word boundary beats a match inside another word",
      text: "good go",
      issues: [issue("go")],
      spans: [[5, 7]],
    },
    {
      name: "word boundary beats better context",
      text: "good go. A go",
      issues: [issue("go", "oo", "")],
      spans: [[5, 7]],
    },
    {
      name: "accented letters and digits are word characters",
      text: "égo go ago2 go",
      issues: [issue("go")],
      spans: [[4, 6]],
    },
    {
      name: "single occurrence inside a word is still used",
      text: "good",
      issues: [issue("go")],
      spans: [[0, 2]],
    },
    {
      name: "case-insensitive fallback",
      text: "He GO to school",
      issues: [issue("he go")],
      spans: [[0, 5]],
    },
    {
      name: "white-space-normalised fallback with a newline",
      text: "He go\nto school",
      issues: [issue("go to")],
      spans: [[3, 8]],
    },
    {
      name: "white-space-normalised fallback with several spaces",
      text: "He   go    to school",
      issues: [issue("He go to")],
      spans: [[0, 13]],
    },
    {
      name: "curly apostrophe matches a straight one",
      text: "I don’t know nothing.",
      issues: [issue("don't know")],
      spans: [[2, 12]],
    },
    {
      name: "dash and quote folding",
      text: "She said “hello” — twice.",
      issues: [issue('"hello" - twice')],
      spans: [[9, 24]],
    },
    {
      name: "fallback maps accented text back correctly",
      text: "Café  AU lait",
      issues: [issue("café au")],
      spans: [[0, 8]],
    },
    {
      name: "fallback maps back after emoji",
      text: "😀😀 Café  AU lait",
      issues: [issue("café au")],
      spans: [[5, 13]],
    },
    {
      name: "fallback match across a long run of white space ends after the last word",
      text: "go   \n  home",
      issues: [issue("go home")],
      spans: [[0, 12]],
    },
    {
      name: "fallback with several matches uses the context",
      text: "The Big  Dog. A big dog.",
      issues: [issue("BIG DOG", "A ", "")],
      spans: [[16, 23]],
    },
    {
      name: "fallback with several matches uses the context (first one)",
      text: "The Big  Dog. A big dog.",
      issues: [issue("BIG DOG", "The ", "")],
      spans: [[4, 12]],
    },
    {
      name: "not in the text",
      text: "Nothing to see.",
      issues: [issue("something else")],
      unplaced: 1,
    },
    {
      name: "empty snippet",
      text: "Some text.",
      issues: [issue(""), issue("   ")],
      unplaced: 2,
    },
    { name: "empty text", text: "", issues: [issue("a")], unplaced: 1 },
    {
      name: "overlap keeps the earlier one in the text",
      text: "He go to the school now",
      issues: [issue("go to the school"), issue("He go")],
      spans: [[0, 5]],
      overlapping: 1,
    },
    {
      name: "touching spans do not overlap",
      text: "abcd",
      issues: [issue("cd"), issue("ab")],
      spans: [
        [0, 2],
        [2, 4],
      ],
    },
    {
      name: "same span twice",
      text: "He go home",
      issues: [issue("go"), issue("go")],
      spans: [[3, 5]],
      overlapping: 1,
    },
    {
      name: "result is sorted by position",
      text: "one two three",
      issues: [issue("three"), issue("one"), issue("two")],
      spans: [
        [0, 3],
        [4, 7],
        [8, 13],
      ],
    },
    {
      name: "emoji before the snippet",
      text: "😀😀 he go",
      issues: [issue("he go")],
      spans: [[5, 10]],
    },
    {
      name: "an emoji snippet",
      text: "a 😀 b 😀",
      issues: [issue("😀", "a ")],
      spans: [[2, 4]],
    },
    {
      name: "overlapping occurrences of a repeating snippet",
      text: "aaa",
      issues: [issue("aa", "a", "")],
      spans: [[1, 3]],
    },
    {
      name: "snippet is trimmed",
      text: "He go home",
      issues: [issue("  go  ")],
      spans: [[3, 5]],
    },
    {
      name: "a lone low surrogate never matches inside an emoji",
      text: "😀",
      issues: [issue("\ude00")],
      unplaced: 1,
    },
    {
      name: "a lone high surrogate never matches inside an emoji",
      text: "x😀",
      issues: [issue("\ud83d")],
      unplaced: 1,
    },
    {
      name: "a lone surrogate in the text can be found",
      text: "a\ud83dz",
      issues: [issue("\ud83d")],
      spans: [[1, 2]],
    },
    {
      name: "an emoji snippet does not match half of two emoji",
      text: "😀😁",
      issues: [issue("\ude00\ud83d")],
      unplaced: 1,
    },
  ])("$name", ({ text, issues, spans, unplaced, overlapping }) => {
    const result = locate(text, issues);
    expect(result.unplaced).toBe(unplaced ?? 0);
    expect(result.overlapping).toBe(overlapping ?? 0);
    expect(result.placed.map((p) => [p.start, p.end])).toEqual(spans ?? []);
  });

  it("keeps the issue object", () => {
    const first = issue("go");
    const result = locate("He go", [first]);
    expect(result.placed[0]?.issue).toBe(first);
  });

  it("a snippet with a surrogate pair is found when both halves are there", () => {
    const text = "x😀y";
    expect(locate(text, [issue("😀")]).placed.map((p) => [p.start, p.end])).toEqual([[1, 3]]);
  });
});

describe("occurrences", () => {
  it.each([
    {
      text: "aaa",
      snippet: "aa",
      want: [
        [0, 2],
        [1, 3],
      ],
    },
    {
      text: "abab",
      snippet: "ab",
      want: [
        [0, 2],
        [2, 4],
      ],
    },
    { text: "abc", snippet: "", want: [] },
    { text: "ab", snippet: "abc", want: [] },
    {
      text: "😀😀",
      snippet: "😀",
      want: [
        [0, 2],
        [2, 4],
      ],
    },
    { text: "😀😀", snippet: "\ude00\ud83d", want: [] },
  ])("$snippet in $text", ({ text, snippet, want }) => {
    expect(occurrences(text, snippet).map((s) => [s.start, s.end])).toEqual(want);
  });
});

describe("appendLocated", () => {
  it("shifts the offsets of each chunk and adds the counters", () => {
    let all = EMPTY_LOCATE_RESULT;
    all = appendLocated(all, locate("He go", [issue("go"), issue("zzz")]), 0);
    all = appendLocated(all, locate("She go", [issue("go"), issue("She")]), 100);
    expect(all.placed.map((p) => p.start)).toEqual([3, 100, 104]);
    expect(all.unplaced).toBe(1);
    expect(all.overlapping).toBe(0);
  });
});
