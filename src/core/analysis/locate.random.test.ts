import { describe, expect, it } from "vitest";
import { locate, occurrences } from "./locate";
import type { Issue } from "./parse";
import { resolveErrorType } from "./taxonomy";
import { Prng } from "./testing/prng";
import { isBoundary, trimSpace } from "./text";

// Pieces that stress the locator: a small alphabet so that snippets repeat, white space of several
// kinds, typographic quotes and dashes, accented letters, a pair above U+FFFF, and lone surrogates
// (text a browser never produces from a textarea, but the locator must still not throw on it).
const PIECES = [
  "a",
  "b",
  "A",
  "B",
  "é",
  "É",
  "1",
  " ",
  "  ",
  "\n",
  "\t",
  " ",
  ".",
  "'",
  "’",
  '"',
  "“",
  "-",
  "—",
  "😀",
  "😁",
  "\ud83d",
  "\ude00",
  "ß",
  "İ",
  "Σ",
];

function randomIssue(rng: Prng, text: string): Issue {
  const snippetFrom = (): string => {
    // Half the time a slice of the text itself (so that it is found), else a random string.
    if (text.length > 0 && rng.int(2) === 0) {
      const start = rng.int(text.length);
      return text.slice(start, start + 1 + rng.int(6));
    }
    return rng.string(PIECES, rng.int(5));
  };
  return {
    text: snippetFrom(),
    type: resolveErrorType("article"),
    message: "m",
    contextBefore: rng.string(PIECES, rng.int(4)),
    contextAfter: rng.string(PIECES, rng.int(4)),
  };
}

describe("locate (randomised)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "any input gives valid, ordered, in-range spans (seed %i)",
    (seed) => {
      const rng = new Prng(seed);
      for (let round = 0; round < 400; round++) {
        const text = rng.string(PIECES, rng.int(60));
        const issues = Array.from({ length: rng.int(8) }, () => randomIssue(rng, text));

        const result = locate(text, issues);

        expect(result.placed.length + result.unplaced + result.overlapping).toBe(issues.length);
        let lastEnd = 0;
        for (const p of result.placed) {
          expect(p.start).toBeGreaterThanOrEqual(lastEnd);
          expect(p.end).toBeGreaterThan(p.start);
          expect(p.end).toBeLessThanOrEqual(text.length);
          // Never inside a surrogate pair.
          expect(isBoundary(text, p.start)).toBe(true);
          expect(isBoundary(text, p.end)).toBe(true);
          lastEnd = p.end;
        }
        for (const p of result.placed) {
          // A snippet that occurs literally is placed on a literal occurrence.
          const snippet = trimSpace(p.issue.text);
          if (occurrences(text, snippet).length > 0) {
            expect(text.slice(p.start, p.end)).toBe(snippet);
          }
        }
      }
    },
  );

  it("is deterministic", () => {
    const rng = new Prng(99);
    const text = rng.string(PIECES, 80);
    const issues = Array.from({ length: 6 }, () => randomIssue(rng, text));
    expect(locate(text, issues)).toEqual(locate(text, issues));
  });

  it("copes with long repetitive text and many issues", () => {
    const text = "ab ".repeat(3000);
    const issues = Array.from({ length: 50 }, () => ({
      text: "ab",
      type: resolveErrorType("article"),
      message: "m",
      contextBefore: "",
      contextAfter: "",
    }));
    const result = locate(text, issues);
    expect(result.placed).toHaveLength(50);
    expect(result.placed.map((p) => p.start)).toEqual(Array.from({ length: 50 }, (_, i) => i * 3));
  });
});
