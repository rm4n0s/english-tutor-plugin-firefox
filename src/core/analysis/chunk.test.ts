import { describe, expect, it } from "vitest";
import {
  chunkSizeFor,
  DEFAULT_CHUNK_WORDS,
  MIN_PARALLEL_CHUNK_WORDS,
  splitChunks,
  splitParagraphs,
  type Chunk,
} from "./chunk";
import { Prng } from "./testing/prng";
import { countWords, isBoundary, trimSpace } from "./text";

/** The invariants every split must keep. */
function expectValid(text: string, chunks: readonly Chunk[], maxWords: number): void {
  let pos = 0;
  let joined = "";
  chunks.forEach((chunk, i) => {
    expect(chunk.start, `chunk ${String(i)} must start where the last ended`).toBe(pos);
    expect(text.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
    expect(trimSpace(chunk.text), `chunk ${String(i)} is only white space`).not.toBe("");
    expect(countWords(chunk.text)).toBeLessThanOrEqual(maxWords);
    joined += chunk.text;
    pos += chunk.text.length;
  });
  if (chunks.length > 0) expect(joined).toBe(text);
}

function words(n: number, word: string): string {
  return Array.from({ length: n }, () => word).join(" ");
}

describe("splitChunks", () => {
  it.each([
    { name: "empty", text: "", maxWords: 5, texts: [] },
    { name: "only white space", text: " \n\n\t ", maxWords: 5, texts: [] },
    {
      name: "a short text is one chunk",
      text: "One two three.",
      maxWords: 5,
      texts: ["One two three."],
    },
    { name: "the default size when zero", text: "One two.", maxWords: 0, texts: ["One two."] },
    {
      name: "paragraphs are packed up to the limit",
      text: "a b c\n\nd e f\n\ng h i\n\nj k l",
      maxWords: 6,
      texts: ["a b c\n\nd e f\n\n", "g h i\n\nj k l"],
    },
    {
      name: "two small paragraphs share a chunk",
      text: "a b\n\nc d\n\ne f g h i j",
      maxWords: 6,
      texts: ["a b\n\nc d\n\n", "e f g h i j"],
    },
    {
      name: "leading blank lines stay with the first chunk",
      text: "\n\n  a b c\n\nd e f",
      maxWords: 3,
      texts: ["\n\n  a b c\n\n", "d e f"],
    },
    {
      name: "trailing blank lines stay with the last chunk",
      text: "a b c\n\nd e f\n\n\n",
      maxWords: 3,
      texts: ["a b c\n\n", "d e f\n\n\n"],
    },
    {
      name: "blank lines with spaces separate paragraphs",
      text: "a b c\n \t \nd e f",
      maxWords: 3,
      texts: ["a b c\n \t \n", "d e f"],
    },
    {
      name: "windows line endings",
      text: "a b c\r\n\r\nd e f",
      maxWords: 3,
      texts: ["a b c\r\n\r\n", "d e f"],
    },
    {
      name: "a long paragraph is cut between sentences",
      text: "One two three. Four five six. Seven eight nine.",
      maxWords: 6,
      texts: ["One two three. Four five six. ", "Seven eight nine."],
    },
    {
      name: "a sentence ends with a quote",
      text: 'He said "stop now." Then we left early today.',
      maxWords: 5,
      texts: ['He said "stop now." ', "Then we left early today."],
    },
    {
      name: "a sentence ends with a typographic quote",
      text: "He said “stop now.” Then we left early today.",
      maxWords: 5,
      texts: ["He said “stop now.” ", "Then we left early today."],
    },
    {
      name: "a long sentence is cut between words",
      text: "a b c d e f g",
      maxWords: 3,
      texts: ["a b c ", "d e f ", "g"],
    },
    {
      name: "dots without a space do not split",
      text: "see a.b.c now ok yes",
      maxWords: 3,
      texts: ["see a.b.c now ", "ok yes"],
    },
    {
      name: "a long paragraph after a short one",
      text: "a b\n\nc d e f. g h i j. k l",
      maxWords: 4,
      texts: ["a b\n\n", "c d e f. ", "g h i j. ", "k l"],
    },
    {
      name: "unicode words",
      text: "café 日本語 😀 naïve",
      maxWords: 2,
      texts: ["café 日本語 ", "😀 naïve"],
    },
    {
      name: "non-breaking spaces separate words",
      text: "a b c d",
      maxWords: 2,
      texts: ["a b ", "c d"],
    },
    { name: "exactly at the limit stays whole", text: "a b c", maxWords: 3, texts: ["a b c"] },
    {
      name: "one word over the limit is cut",
      text: "a b c d",
      maxWords: 3,
      texts: ["a b c ", "d"],
    },
  ])("$name", ({ text, maxWords, texts }) => {
    const chunks = splitChunks(text, maxWords);
    expectValid(text, chunks, maxWords > 0 ? maxWords : DEFAULT_CHUNK_WORDS);
    expect(chunks.map((c) => c.text)).toEqual(texts);
  });

  it("splits a large document at paragraph boundaries", () => {
    // 50 paragraphs of 120 words: 16 paragraphs (1920 words) fit in a chunk, so 4 chunks.
    const text = Array.from({ length: 50 }, () => words(120, "word")).join("\n\n");
    const chunks = splitChunks(text);
    expectValid(text, chunks, DEFAULT_CHUNK_WORDS);
    expect(chunks).toHaveLength(4);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.endsWith("\n\n")).toBe(true);
  });

  it("cuts one huge paragraph without sentence ends between words", () => {
    const text = words(5000, "x");
    const chunks = splitChunks(text);
    expectValid(text, chunks, DEFAULT_CHUNK_WORDS);
    expect(chunks).toHaveLength(3);
  });

  it("never splits a surrogate pair (randomised)", () => {
    const rng = new Prng(7);
    const pieces = [
      "a",
      "bb",
      " ",
      "  ",
      "\n",
      "\n\n",
      ".",
      ". ",
      "!",
      '"',
      "😀",
      "é",
      " ",
      "\ud83d",
    ];
    for (let round = 0; round < 1500; round++) {
      const text = rng.string(pieces, rng.int(50));
      const maxWords = 1 + rng.int(6);
      const chunks = splitChunks(text, maxWords);
      if (countWords(text) === 0) {
        expect(chunks).toEqual([]);
        continue;
      }
      expectValid(text, chunks, maxWords);
      for (const chunk of chunks) expect(isBoundary(text, chunk.start)).toBe(true);
    }
  });
});

describe("chunkSizeFor", () => {
  const text = (n: number) => words(n, "word");
  it.each([
    { name: "one at a time keeps the size", words: 5000, parallel: 1, want: 2000 },
    { name: "zero parallel is one", words: 5000, parallel: 0, want: 2000 },
    { name: "parallel spreads a long text", words: 5000, parallel: 4, want: 1250 },
    { name: "rounds up", words: 5001, parallel: 4, want: 1251 },
    {
      name: "never makes pieces under the minimum",
      words: 300,
      parallel: 4,
      want: MIN_PARALLEL_CHUNK_WORDS,
    },
    { name: "never exceeds the size", words: 20000, parallel: 4, want: 2000 },
    { name: "a small default size wins", words: 20000, parallel: 4, size: 100, want: 100 },
  ])("$name", ({ words: n, parallel, size, want }) => {
    expect(chunkSizeFor(text(n), parallel, size)).toBe(want);
  });
});

describe("splitParagraphs", () => {
  it("covers the text with contiguous segments", () => {
    const t = "a\n\nb\n\n\nc";
    const segments = splitParagraphs(t);
    expect(segments.map((s) => t.slice(s.start, s.end))).toEqual(["a\n\n", "b\n\n\n", "c"]);
  });
});
