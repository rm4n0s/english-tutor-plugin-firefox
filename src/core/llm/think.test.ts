import { describe, expect, it } from "vitest";
import { stripThinking, ThinkFilter } from "./think";

describe("stripThinking", () => {
  it.each([
    { text: "plain answer", expected: "plain answer" },
    { text: "<think>hmm</think>answer", expected: "answer" },
    { text: "hmm</think>\n\nanswer", expected: "\n\nanswer" },
    { text: "a</think>b</think>c", expected: "c" },
    { text: "<think>never closed", expected: "<think>never closed" },
  ])("$text", ({ text, expected }) => {
    expect(stripThinking(text)).toBe(expected);
  });
});

function run(chunks: string[]): string {
  const filter = new ThinkFilter();
  return chunks.map((chunk) => filter.push(chunk)).join("") + filter.end();
}

describe("ThinkFilter", () => {
  it.each([
    {
      name: "text that starts any other way passes",
      chunks: ["Hello ", "world"],
      expected: "Hello world",
    },
    {
      name: "a leading block is hidden",
      chunks: ["<think>plan it</think>Hello"],
      expected: "Hello",
    },
    {
      name: "a block split into tiny pieces",
      chunks: ["<", "thi", "nk>pla", "n</thi", "nk>\n", "Hel", "lo"],
      expected: "Hello",
    },
    { name: "white space before the block", chunks: ["\n <think>x</think>ok"], expected: "ok" },
    {
      name: "a block that never closes shows nothing",
      chunks: ["<think>plan", " more"],
      expected: "",
    },
    { name: "a short text that is a prefix of the tag", chunks: ["<th"], expected: "<th" },
    {
      name: "a closing tag in the middle of a normal text passes",
      chunks: ["a ", "</think>", " b"],
      expected: "a </think> b",
    },
    { name: "an empty stream", chunks: [], expected: "" },
  ])("$name", ({ chunks, expected }) => {
    expect(run(chunks)).toBe(expected);
  });
});
