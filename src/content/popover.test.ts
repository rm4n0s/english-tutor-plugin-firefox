import { describe, expect, it, vi } from "vitest";
import type { ContentMessage } from "../core/page-mode/protocol";
import type { Box } from "../ui/mirror";
import type { BoxState } from "./box-state";
import type { FrameView } from "./frame-link";
import { anchorFor, PopoverController, type PopoverTarget } from "./popover";
import type { BoxUnderlines } from "./underlines";

const rect = (left: number, top: number, width = 50, height = 20): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

/** A box whose issues are at the given rectangles (issue id to lines). */
function fakeTarget(
  id: number,
  rects: Record<number, Box[]>,
): PopoverTarget & {
  rects: Record<number, Box[]>;
} {
  return {
    rects,
    state: { id } as unknown as BoxState,
    underlines: {
      rectsOf: (issue: number) => rects[issue] ?? [],
    } as unknown as BoxUnderlines,
  };
}

function setup(viewport = { width: 1280, height: 800 }) {
  const posted: ContentMessage[] = [];
  const views: (FrameView | undefined)[] = [];
  const onChange = vi.fn();
  const controller = new PopoverController({
    link: {
      post: (message) => posted.push(message),
      setView: (view) => views.push(view),
    },
    viewport: () => viewport,
    onChange,
  });
  return { controller, posted, views, onChange };
}

describe("anchorFor", () => {
  const lines = [rect(100, 100, 200), rect(20, 124, 80)];

  it.each([
    { name: "the first line with no point", point: undefined, expected: lines[0] },
    { name: "the line that holds the point", point: { x: 50, y: 130 }, expected: lines[1] },
    { name: "the first line for a point in none", point: { x: 900, y: 900 }, expected: lines[0] },
  ])("is $name", ({ point, expected }) => {
    expect(anchorFor(lines, point)).toBe(expected);
  });

  it("refuses an issue with no rectangle", () => {
    expect(() => anchorFor([])).toThrow(RangeError);
  });
});

describe("PopoverController", () => {
  it("opens for an issue: tells the frame, puts the frame under the underline, hidden until it has its size", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 7);
    expect(t.posted).toEqual([{ type: "popover-open", box: 1, issue: 7, maxHeight: 340 }]);
    expect(t.views.at(-1)).toMatchObject({ left: 300, top: 126, width: 360, visible: false });
    expect(t.controller.open).toEqual({ target, issue: 7 });
    expect(t.controller.selectedIn(target)).toBe(7);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.controller.sized(1, 7, 180);
    expect(t.views.at(-1)).toMatchObject({ top: 126, height: 180, visible: true });
  });

  it("puts the card above the underline when there is no room below", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 700)] });
    t.controller.show(target, 7);
    t.controller.sized(1, 7, 200);
    expect(t.views.at(-1)).toMatchObject({ top: 700 - 6 - 200, height: 200 });
  });

  it("limits the card to the room it has, even when the frame reports more", () => {
    const t = setup({ width: 1280, height: 400 });
    const target = fakeTarget(1, { 7: [rect(300, 200)] });
    t.controller.show(target, 7);
    const maxHeight = (t.posted[0] as { maxHeight: number }).maxHeight;
    t.controller.sized(1, 7, 900);
    expect(t.views.at(-1)!.height).toBeLessThanOrEqual(maxHeight);
  });

  it("does nothing for an issue with no rectangle, or when it is already showing it", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 8);
    expect(t.posted).toEqual([]);
    t.controller.show(target, 7);
    t.controller.show(target, 7);
    expect(t.posted).toHaveLength(1);
  });

  it("switches to another issue with one more message, without closing", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)], 8: [rect(500, 100)] });
    t.controller.show(target, 7);
    t.controller.sized(1, 7, 180);
    t.controller.show(target, 8);
    expect(t.posted.map((m) => m.type)).toEqual(["popover-open", "popover-open"]);
    expect(t.controller.open?.issue).toBe(8);
    // Hidden again until the new card has its own size; the old issue's size is late and ignored.
    expect(t.views.at(-1)).toMatchObject({ left: 500, visible: false });
    t.controller.sized(1, 7, 300);
    expect(t.views.at(-1)).toMatchObject({ visible: false });
  });

  it("uses the line of a wrapped issue that was clicked", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(500, 100, 100), rect(60, 124, 40)] });
    t.controller.show(target, 7, { x: 70, y: 130 });
    expect(t.views.at(-1)).toMatchObject({ left: 60, top: 124 + 20 + 6 });
  });

  it("closes: tells the frame, hides the frame, clears the selection", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 7);
    t.controller.close();
    expect(t.posted.at(-1)).toEqual({ type: "popover-close", box: 1 });
    expect(t.views.at(-1)).toBeUndefined();
    expect(t.controller.open).toBeUndefined();
    expect(t.controller.selectedIn(target)).toBeNull();
    // Closing again is nothing.
    const posts = t.posted.length;
    t.controller.close();
    expect(t.posted).toHaveLength(posts);
  });

  it("closes without a word when the frame closed it", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 7);
    expect(t.controller.closedByFrame(2)).toBe(false);
    expect(t.controller.closedByFrame(1)).toBe(true);
    expect(t.posted).toHaveLength(1);
    expect(t.views.at(-1)).toBeUndefined();
    expect(t.controller.open).toBeUndefined();
  });

  it("follows the underline when the page scrolls and closes when the issue is gone", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 7);
    t.controller.sized(1, 7, 180);
    target.rects[7] = [rect(300, 60)];
    t.controller.place();
    expect(t.views.at(-1)).toMatchObject({ top: 86 });
    // The issue scrolled out of the box (or an edit removed it): no rectangle, the popover goes.
    target.rects[7] = [];
    t.controller.place();
    expect(t.controller.open).toBeUndefined();
    expect(t.posted.at(-1)).toEqual({ type: "popover-close", box: 1 });
  });

  it("forgets only its own box", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    const other = fakeTarget(2, {});
    t.controller.show(target, 7);
    t.controller.forget(other);
    expect(t.controller.open).toBeDefined();
    t.controller.forget(target);
    expect(t.controller.open).toBeUndefined();
  });

  it("ignores the size of a card for another box", () => {
    const t = setup();
    const target = fakeTarget(1, { 7: [rect(300, 100)] });
    t.controller.show(target, 7);
    t.controller.sized(2, 7, 100);
    expect(t.views.at(-1)).toMatchObject({ visible: false });
  });
});
