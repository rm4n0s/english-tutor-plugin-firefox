import { describe, expect, it } from "vitest";
import { FakeScheduler } from "../testing/fake-clock";
import { AutoCheck } from "./auto-check";

function setup(
  options: { enabled?: boolean; delay?: number; busy?: boolean; canCheck?: boolean } = {},
) {
  const scheduler = new FakeScheduler();
  const box = { enabled: true, delay: 3, busy: false, canCheck: true, ...options };
  const started: number[] = [];
  const auto = new AutoCheck({
    scheduler,
    enabled: () => box.enabled,
    delaySeconds: () => box.delay,
    busy: () => box.busy,
    canCheck: () => box.canCheck,
    start: () => started.push(started.length),
  });
  return { scheduler, box, started, auto };
}

describe("AutoCheck", () => {
  it("starts a check after the pause that follows an edit", () => {
    const { scheduler, started, auto } = setup();
    auto.edited();
    scheduler.advance(2_999);
    expect(started).toHaveLength(0);
    scheduler.advance(1);
    expect(started).toHaveLength(1);
  });

  it("restarts the pause on every edit, so it fires once, after the last one", () => {
    const { scheduler, started, auto } = setup();
    auto.edited();
    scheduler.advance(2_000);
    auto.edited();
    scheduler.advance(2_000);
    auto.edited();
    scheduler.advance(2_999);
    expect(started).toHaveLength(0);
    scheduler.advance(1);
    expect(started).toHaveLength(1);
    scheduler.advance(60_000);
    expect(started).toHaveLength(1);
  });

  it.each([1, 3, 10, 60])("uses the delay in seconds, here %i", (delay) => {
    const { scheduler, started, auto } = setup({ delay });
    auto.edited();
    scheduler.advance(delay * 1000 - 1);
    expect(started).toHaveLength(0);
    scheduler.advance(1);
    expect(started).toHaveLength(1);
  });

  it("reads the delay each time the pause restarts", () => {
    const { scheduler, box, started, auto } = setup();
    auto.edited();
    box.delay = 10;
    auto.edited();
    scheduler.advance(9_999);
    expect(started).toHaveLength(0);
    scheduler.advance(1);
    expect(started).toHaveLength(1);
  });

  it("does nothing while auto-check is off", () => {
    const { scheduler, started, auto } = setup({ enabled: false });
    auto.edited();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(60_000);
    expect(started).toHaveLength(0);
  });

  it("an edit while it is off cancels a pause that was waiting", () => {
    const { scheduler, box, started, auto } = setup();
    auto.edited();
    box.enabled = false;
    auto.edited();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(60_000);
    expect(started).toHaveLength(0);
  });

  it("does not fire if it was turned off during the pause", () => {
    const { scheduler, box, started, auto } = setup();
    auto.edited();
    box.enabled = false;
    scheduler.advance(3_000);
    expect(started).toHaveLength(0);
    expect(scheduler.pending).toBe(0);
  });

  it("stop() ends the wait", () => {
    const { scheduler, started, auto } = setup();
    auto.edited();
    auto.stop();
    scheduler.advance(10_000);
    expect(started).toHaveLength(0);
  });

  it("waits for another pause when a check is running, and does not cancel it", () => {
    const { scheduler, box, started, auto } = setup({ busy: true });
    auto.edited();
    scheduler.advance(3_000);
    expect(started).toHaveLength(0);
    expect(scheduler.pending).toBe(1);
    scheduler.advance(3_000);
    expect(started).toHaveLength(0);
    box.busy = false; // the running check ended
    scheduler.advance(3_000);
    expect(started).toHaveLength(1);
    expect(scheduler.pending).toBe(0);
  });

  it("an edit while it waits for a running check restarts the pause", () => {
    const { scheduler, box, started, auto } = setup({ busy: true });
    auto.edited();
    scheduler.advance(3_000); // fired while busy, waiting again
    box.busy = false;
    scheduler.advance(2_000);
    auto.edited();
    scheduler.advance(2_999);
    expect(started).toHaveLength(0);
    scheduler.advance(1);
    expect(started).toHaveLength(1);
  });

  it("does not start a check of a text that cannot be checked", () => {
    const { scheduler, started, auto } = setup({ canCheck: false });
    auto.edited();
    scheduler.advance(3_000);
    expect(started).toHaveLength(0);
    expect(scheduler.pending).toBe(0);
  });
});
