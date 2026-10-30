// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ContentMessage } from "../core/page-mode/protocol";
import { DialogController, type DialogTarget } from "./dialog";
import type { FrameView } from "./frame-link";

function setup() {
  const posted: ContentMessage[] = [];
  const views: (FrameView | undefined)[] = [];
  const element = document.createElement("textarea");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 100,
    right: 400,
    bottom: 250,
    width: 300,
    height: 150,
  } as DOMRect);
  const reveal = vi.fn();
  const changed = vi.fn();
  const target = { state: { id: 1, element } } as unknown as DialogTarget;
  const other = { state: { id: 2, element } } as unknown as DialogTarget;
  const controller = new DialogController({
    link: {
      post: (message) => {
        posted.push(message);
      },
      setView: (view) => {
        views.push(view);
      },
    },
    viewport: () => ({ width: 1280, height: 800 }),
    onChange: changed,
    reveal,
  });
  return { controller, posted, views, target, other, reveal, changed };
}

describe("DialogController", () => {
  it("opens for a box: asks the frame, and puts the frame next to the box, hidden until it is drawn", () => {
    const t = setup();
    t.controller.show(t.target, 3);
    expect(t.posted).toEqual([{ type: "dialog-open", box: 1, issue: 3 }]);
    expect(t.views.at(-1)).toEqual({
      left: 408,
      top: 100,
      width: 440,
      height: 520,
      visible: false,
    });
    expect(t.controller.open).toEqual({ target: t.target, issue: null });
    t.controller.drawn(1);
    expect(t.views.at(-1)?.visible).toBe(true);
  });

  it.each([
    {
      name: "drawn",
      act: (c: DialogController) => {
        c.drawn(2);
      },
    },
    {
      name: "selected",
      act: (c: DialogController) => {
        c.selected(2, 5);
      },
    },
    { name: "closedByFrame", act: (c: DialogController) => c.closedByFrame(2) },
  ])("ignores $name for another box", ({ act }) => {
    const t = setup();
    t.controller.show(t.target, null);
    const views = t.views.length;
    act(t.controller);
    expect(t.controller.open?.target).toBe(t.target);
    expect(t.controller.open?.issue).toBeNull();
    expect(t.views).toHaveLength(views);
    expect(t.reveal).not.toHaveBeenCalled();
  });

  it("selects an issue once: it is drawn as selected and revealed, a second time does nothing", () => {
    const t = setup();
    t.controller.show(t.target, null);
    t.changed.mockClear();
    t.controller.selected(1, 4);
    expect(t.controller.selectedIn(t.target)).toBe(4);
    expect(t.controller.selectedIn(t.other)).toBeNull();
    expect(t.changed).toHaveBeenCalledTimes(1);
    expect(t.reveal).toHaveBeenCalledWith(t.target, 4);
    t.controller.selected(1, 4);
    expect(t.changed).toHaveBeenCalledTimes(1);
    expect(t.reveal).toHaveBeenCalledTimes(1);
    t.controller.selected(1, null);
    expect(t.controller.selectedIn(t.target)).toBeNull();
    expect(t.reveal).toHaveBeenCalledTimes(1);
  });

  it("closes: tells the frame, hides the view, and forgets the selection", () => {
    const t = setup();
    t.controller.show(t.target, null);
    t.controller.selected(1, 4);
    t.posted.length = 0;
    t.controller.close();
    expect(t.posted).toEqual([{ type: "dialog-close", box: 1 }]);
    expect(t.views.at(-1)).toBeUndefined();
    expect(t.controller.open).toBeUndefined();
    expect(t.controller.selectedIn(t.target)).toBeNull();
    // Closing again, or an answer that comes late, does nothing.
    t.controller.close();
    t.controller.selected(1, 4);
    t.controller.drawn(1);
    expect(t.posted).toHaveLength(1);
    expect(t.reveal).toHaveBeenCalledTimes(1);
  });

  it("closes when the frame did, without an echo", () => {
    const t = setup();
    t.controller.show(t.target, null);
    t.posted.length = 0;
    expect(t.controller.closedByFrame(1)).toBe(true);
    expect(t.posted).toEqual([]);
    expect(t.views.at(-1)).toBeUndefined();
    expect(t.controller.closedByFrame(1)).toBe(false);
  });

  it("is replaced when it opens for another box", () => {
    const t = setup();
    t.controller.show(t.target, null);
    t.controller.selected(1, 4);
    t.controller.show(t.other, null);
    expect(t.controller.open?.target).toBe(t.other);
    expect(t.controller.selectedIn(t.target)).toBeNull();
    expect(t.posted.at(-1)).toEqual({ type: "dialog-open", box: 2, issue: null });
    // It is not shown until the frame has drawn it for the new box.
    expect(t.views.at(-1)?.visible).toBe(false);
  });

  it("goes with its box", () => {
    const t = setup();
    t.controller.show(t.target, null);
    t.controller.forget(t.other);
    expect(t.controller.open).toBeDefined();
    t.controller.forget(t.target);
    expect(t.controller.open).toBeUndefined();
  });
});
