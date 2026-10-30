import { describe, expect, it } from "vitest";
import { SystemClock } from "./clock";
import { FakeClock } from "./testing/fake-clock";

describe("SystemClock", () => {
  it("returns the current time in milliseconds", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe("FakeClock", () => {
  it.each([
    { name: "starts at 0", start: undefined, steps: [], expected: 0 },
    { name: "starts where told", start: 1000, steps: [], expected: 1000 },
    { name: "advances", start: 1000, steps: [5, 10], expected: 1015 },
    { name: "advances by zero", start: 7, steps: [0], expected: 7 },
  ])("$name", ({ start, steps, expected }) => {
    const clock = start === undefined ? new FakeClock() : new FakeClock(start);
    for (const step of steps) clock.advance(step);
    expect(clock.now()).toBe(expected);
  });

  it("can be set to any time", () => {
    const clock = new FakeClock(5);
    clock.set(99);
    expect(clock.now()).toBe(99);
  });
});
