import { describe, expect, it } from "vitest";
import { SystemClock, SystemScheduler } from "./clock";
import { FakeClock, FakeScheduler } from "./testing/fake-clock";

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

describe("SystemScheduler", () => {
  it("runs the function once after the delay, and not after it was cancelled", async () => {
    const calls: string[] = [];
    const scheduler = new SystemScheduler();
    scheduler.after(5, () => calls.push("ran"));
    scheduler.after(5, () => calls.push("cancelled"))();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toEqual(["ran"]);
  });
});

describe("FakeScheduler", () => {
  it("runs due functions in order when time advances, and not before", () => {
    const calls: string[] = [];
    const scheduler = new FakeScheduler();
    scheduler.after(20, () => calls.push("b"));
    scheduler.after(10, () => calls.push("a"));
    scheduler.advance(9);
    expect(calls).toEqual([]);
    scheduler.advance(1);
    expect(calls).toEqual(["a"]);
    scheduler.advance(100);
    expect(calls).toEqual(["a", "b"]);
    expect(scheduler.pending).toBe(0);
  });

  it("does not run a cancelled function, and runs one scheduled by another from the new time", () => {
    const calls: string[] = [];
    const scheduler = new FakeScheduler();
    scheduler.after(10, () => calls.push("cancelled"))();
    scheduler.after(10, () => {
      calls.push("first");
      scheduler.after(5, () => calls.push("second"));
    });
    scheduler.advance(14);
    expect(calls).toEqual(["first"]);
    scheduler.advance(1);
    expect(calls).toEqual(["first", "second"]);
  });
});
