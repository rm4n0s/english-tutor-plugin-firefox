// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../core/testing/fake-clock";
import { LAYOUT_POLL_MS, LayoutWatcher } from "./layout-watch";

afterEach(() => {
  vi.restoreAllMocks();
});

/** An element whose rectangle a test changes. */
function movable() {
  const element = document.createElement("div");
  const rect = { left: 10, top: 20, width: 300, height: 100 };
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({ ...rect }) as DOMRect);
  return { element, rect };
}

function make(elements: () => Element[]) {
  const scheduler = new FakeScheduler();
  const onMoved = vi.fn();
  const watcher = new LayoutWatcher({ scheduler, elements, onMoved });
  return { scheduler, onMoved, watcher };
}

describe("LayoutWatcher", () => {
  it("reports nothing while the boxes stay where they are", () => {
    const { element } = movable();
    const { scheduler, onMoved, watcher } = make(() => [element]);
    watcher.start();
    scheduler.advance(LAYOUT_POLL_MS * 10);
    expect(onMoved).not.toHaveBeenCalled();
    expect(watcher.running).toBe(true);
  });

  it.each([
    { name: "moved down", change: { top: 60 } },
    { name: "moved right", change: { left: 11 } },
    { name: "got wider", change: { width: 320 } },
    { name: "got taller", change: { height: 80 } },
    { name: "moved a fraction of a pixel, more than a tenth", change: { top: 20.5 } },
  ])("reports a box that $name, once, at the next look", ({ change }) => {
    const { element, rect } = movable();
    const { scheduler, onMoved, watcher } = make(() => [element]);
    watcher.start();
    Object.assign(rect, change);
    scheduler.advance(LAYOUT_POLL_MS - 1);
    expect(onMoved).not.toHaveBeenCalled();
    scheduler.advance(1);
    expect(onMoved).toHaveBeenCalledTimes(1);
    scheduler.advance(LAYOUT_POLL_MS * 4);
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  it("follows a box that keeps moving (an animation): one report for each look that differs", () => {
    const { element, rect } = movable();
    const { scheduler, onMoved, watcher } = make(() => [element]);
    watcher.start();
    for (let i = 1; i <= 3; i++) {
      rect.top += 10;
      scheduler.advance(LAYOUT_POLL_MS);
    }
    expect(onMoved).toHaveBeenCalledTimes(3);
  });

  it("counts the place at start as seen, and a box that appears later as new", () => {
    const first = movable();
    const second = movable();
    const list = [first.element];
    const { scheduler, onMoved, watcher } = make(() => list);
    watcher.start();
    list.push(second.element);
    scheduler.advance(LAYOUT_POLL_MS);
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  it("stops its timer when there is nothing to watch, and starts again", () => {
    const { element } = movable();
    const list: Element[] = [element];
    const { scheduler, onMoved, watcher } = make(() => list);
    watcher.start();
    list.length = 0;
    scheduler.advance(LAYOUT_POLL_MS);
    expect(watcher.running).toBe(false);
    expect(scheduler.pending).toBe(0);
    list.push(element);
    watcher.start();
    expect(watcher.running).toBe(true);
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("start twice keeps one timer, and stop cancels it", () => {
    const { element } = movable();
    const { scheduler, watcher } = make(() => [element]);
    watcher.start();
    watcher.start();
    expect(scheduler.pending).toBe(1);
    watcher.stop();
    expect(scheduler.pending).toBe(0);
    expect(watcher.running).toBe(false);
  });
});

describe("LayoutWatcher: the tick", () => {
  it("calls onTick at each look while there are boxes, before comparing the rectangles", () => {
    const { element, rect } = movable();
    const scheduler = new FakeScheduler();
    const calls: string[] = [];
    const watcher = new LayoutWatcher({
      scheduler,
      elements: () => [element],
      onMoved: () => calls.push("moved"),
      onTick: () => calls.push("tick"),
    });
    watcher.start();
    scheduler.advance(LAYOUT_POLL_MS);
    rect.top = 99;
    scheduler.advance(LAYOUT_POLL_MS);
    expect(calls).toEqual(["tick", "tick", "moved"]);
  });

  it("calls onTick no more once there is no box, and the timer stops", () => {
    const { element } = movable();
    const list: Element[] = [element];
    const scheduler = new FakeScheduler();
    const onTick = vi.fn();
    const watcher = new LayoutWatcher({
      scheduler,
      elements: () => list,
      onMoved: vi.fn(),
      onTick,
    });
    watcher.start();
    scheduler.advance(LAYOUT_POLL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    list.length = 0;
    scheduler.advance(LAYOUT_POLL_MS * 5);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);
  });

  it("copes with a tick that removes the box it was called for", () => {
    const { element } = movable();
    const list: Element[] = [element];
    const scheduler = new FakeScheduler();
    const watcher = new LayoutWatcher({
      scheduler,
      elements: () => list,
      onMoved: vi.fn(),
      onTick: () => {
        list.length = 0;
      },
    });
    watcher.start();
    scheduler.advance(LAYOUT_POLL_MS * 3);
    expect(watcher.running).toBe(false);
    expect(scheduler.pending).toBe(0);
  });
});
