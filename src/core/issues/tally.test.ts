import { describe, expect, it } from "vitest";
import { formatCount, TokenTally, tokenStatusText } from "./tally";

const usage = (inputTokens: number, outputTokens: number, estimated = false) => ({
  inputTokens,
  outputTokens,
  estimated,
});

describe("formatCount", () => {
  it.each([
    { n: 0, expected: "0" },
    { n: 164, expected: "164" },
    { n: 999, expected: "999" },
    { n: 1000, expected: "1k" },
    { n: 1049, expected: "1k" },
    { n: 1100, expected: "1.1k" },
    { n: 5234, expected: "5.2k" },
    { n: 12_345, expected: "12.3k" },
    { n: 999_949, expected: "999.9k" },
    { n: 999_950, expected: "1M" },
    { n: 3_400_000, expected: "3.4M" },
  ])("$n is $expected", ({ n, expected }) => {
    expect(formatCount(n)).toBe(expected);
  });
});

describe("tokenStatusText", () => {
  it.each([
    {
      name: "nothing yet",
      last: null,
      session: usage(0, 0),
      expected: "last: none · session: 0 in / 0 out",
    },
    {
      name: "reported counts",
      last: usage(812, 164),
      session: usage(5234, 1100),
      expected: "last: 812 in / 164 out · session: 5.2k in / 1.1k out",
    },
    {
      name: "an estimated last request",
      last: usage(812, 164, true),
      session: usage(812, 164),
      expected: "last: ~812 in / ~164 out · session: 812 in / 164 out",
    },
    {
      name: "a session with an estimate in it",
      last: usage(10, 5),
      session: usage(2000, 300, true),
      expected: "last: 10 in / 5 out · session: ~2k in / ~300 out",
    },
  ])("$name", ({ last, session, expected }) => {
    expect(tokenStatusText(last, session)).toBe(expected);
  });
});

describe("TokenTally", () => {
  it("adds every recorded request to the session and marks the total estimated if one was", () => {
    const tally = new TokenTally();
    tally.record({ llm: "a", kind: "check", usage: usage(100, 10) });
    tally.record({ llm: "a", kind: "explain", usage: usage(50, 5, true) });
    tally.record({ llm: "a", kind: "check", usage: usage(1, 1) });
    expect(tally.session).toEqual({ inputTokens: 151, outputTokens: 16, estimated: true });
    expect(tally.last).toBeNull();
  });

  it("sets the last request, and ignores a request that reported nothing", () => {
    const tally = new TokenTally();
    tally.setLast(usage(812, 164));
    tally.setLast(usage(0, 0));
    expect(tally.last).toEqual(usage(812, 164));
    tally.setLast(usage(3, 4, true));
    expect(tally.last).toEqual(usage(3, 4, true));
  });

  it("tells a listener about changes until it unsubscribes", () => {
    const tally = new TokenTally();
    let calls = 0;
    const stop = tally.subscribe(() => calls++);
    tally.record({ llm: "a", kind: "check", usage: usage(1, 1) });
    tally.setLast(usage(1, 1));
    tally.setLast(usage(0, 0));
    stop();
    tally.record({ llm: "a", kind: "check", usage: usage(1, 1) });
    expect(calls).toBe(2);
  });
});
