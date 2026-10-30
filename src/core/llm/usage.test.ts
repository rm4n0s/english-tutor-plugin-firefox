import { describe, expect, it } from "vitest";
import { addUsage, count, estimateTokens, estimateUsage, resolveUsage } from "./usage";

describe("estimateTokens", () => {
  it.each([
    { text: "", tokens: 0 },
    { text: "a", tokens: 1 },
    { text: "abcd", tokens: 1 },
    { text: "abcde", tokens: 2 },
    { text: "a".repeat(400), tokens: 100 },
    { text: "😀😀😀😀", tokens: 1 },
    { text: "héllo wörld", tokens: 3 },
  ])("$text.length characters give $tokens", ({ text, tokens }) => {
    expect(estimateTokens(text)).toBe(tokens);
  });
});

describe("resolveUsage", () => {
  it.each([
    {
      name: "reported counts",
      reported: { inputTokens: 10, outputTokens: 5 },
      expected: { inputTokens: 10, outputTokens: 5, estimated: false },
    },
    {
      name: "only an output count",
      reported: { inputTokens: 0, outputTokens: 5 },
      expected: { inputTokens: 0, outputTokens: 5, estimated: false },
    },
    {
      name: "nothing reported",
      reported: undefined,
      expected: { inputTokens: 2, outputTokens: 3, estimated: true },
    },
    {
      name: "zeros reported",
      reported: { inputTokens: 0, outputTokens: 0 },
      expected: { inputTokens: 2, outputTokens: 3, estimated: true },
    },
  ])("$name", ({ reported, expected }) => {
    expect(resolveUsage(reported, "12345678", "123456789")).toEqual(expected);
  });
});

describe("usage helpers", () => {
  it("estimates both sides", () => {
    expect(estimateUsage("abcdefgh", "abc")).toEqual({
      inputTokens: 2,
      outputTokens: 1,
      estimated: true,
    });
  });

  it("adds usages and keeps the estimate flag", () => {
    const a = { inputTokens: 1, outputTokens: 2, estimated: false };
    const b = { inputTokens: 10, outputTokens: 20, estimated: true };
    expect(addUsage(a, b)).toEqual({ inputTokens: 11, outputTokens: 22, estimated: true });
    expect(addUsage(a, a).estimated).toBe(false);
  });

  it.each([
    { value: 5, expected: 5 },
    { value: 5.9, expected: 5 },
    { value: 0, expected: 0 },
    { value: -1, expected: undefined },
    { value: Number.NaN, expected: undefined },
    { value: "5", expected: undefined },
    { value: null, expected: undefined },
  ])("count($value)", ({ value, expected }) => {
    expect(count(value)).toBe(expected);
  });
});
