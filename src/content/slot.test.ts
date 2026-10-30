import { describe, expect, it } from "vitest";
import { claimPageSlot } from "./slot";

describe("claimPageSlot", () => {
  it.each([
    { name: "the first script of a frame", calls: 1, expected: [true] },
    { name: "a second script in the same frame", calls: 2, expected: [true, false] },
    { name: "any number of scripts", calls: 4, expected: [true, false, false, false] },
  ])("$name", ({ calls, expected }) => {
    const scope = {};
    expect(Array.from({ length: calls }, () => claimPageSlot(scope))).toEqual(expected);
  });

  it("is per frame: another global object gets its own slot", () => {
    expect([claimPageSlot({}), claimPageSlot({})]).toEqual([true, true]);
  });

  it("is not a property the page can see by name", () => {
    const scope = {};
    claimPageSlot(scope);
    expect(Object.keys(scope)).toEqual([]);
  });
});
