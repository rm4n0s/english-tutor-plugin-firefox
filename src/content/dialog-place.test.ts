import { describe, expect, it } from "vitest";
import { placeDialog, DIALOG_HEIGHT, DIALOG_WIDTH } from "./dialog-place";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe("placeDialog", () => {
  it.each([
    {
      name: "to the right of a box with room there, its top lined up with the box's",
      anchor: box(100, 100, 400, 250),
      viewport: { width: 1280, height: 800 },
      want: { side: "right", left: 408, top: 100, width: 440, height: 520 },
    },
    {
      name: "moved up so that it stays inside a short window",
      anchor: box(100, 300, 400, 450),
      viewport: { width: 1280, height: 700 },
      want: { side: "right", left: 408, top: 172, width: 440, height: 520 },
    },
    {
      name: "to the left of a box at the window's right edge",
      anchor: box(800, 100, 1260, 250),
      viewport: { width: 1280, height: 800 },
      want: { side: "left", left: 352, top: 100, width: 440, height: 520 },
    },
    {
      name: "below a box that is as wide as the window",
      anchor: box(20, 20, 1260, 120),
      viewport: { width: 1280, height: 800 },
      want: { side: "below", left: 20, top: 128, width: 440, height: 520 },
    },
    {
      name: "above a wide box at the bottom of the window, left edge kept inside",
      anchor: box(4, 600, 1276, 780),
      viewport: { width: 1280, height: 800 },
      want: { side: "above", left: 8, top: 72, width: 440, height: 520 },
    },
    {
      name: "below a wide box, moved left to stay inside a narrow window",
      anchor: box(300, 20, 560, 120),
      viewport: { width: 600, height: 800 },
      want: { side: "below", left: 152, top: 128, width: 440, height: 520 },
    },
    {
      name: "beside a tall box when only the sides have room, still all of it",
      anchor: box(8, 8, 700, 790),
      viewport: { width: 1280, height: 800 },
      // 1280 - 700 - 8 - 8 = 564 on the right: the whole dialog fits there.
      want: { side: "right", left: 708, top: 8, width: 440, height: 520 },
    },
    {
      name: "cut to the room on the right when that is less than 440 but at least 320",
      anchor: box(8, 8, 900, 790),
      viewport: { width: 1280, height: 800 },
      // 1280 - 900 - 8 - 8 = 364 on the right.
      want: { side: "right", left: 908, top: 8, width: 364, height: 520 },
    },
    {
      name: "covering the lower right corner when no side has enough room",
      anchor: box(8, 8, 1272, 792),
      viewport: { width: 1280, height: 800 },
      want: { side: "over", left: 832, top: 272, width: 440, height: 520 },
    },
    {
      name: "as big as a small window allows, with its margin",
      anchor: box(8, 8, 300, 200),
      viewport: { width: 380, height: 400 },
      want: { side: "over", left: 8, top: 8, width: 364, height: 384 },
    },
  ])("puts the dialog $name", ({ anchor, viewport, want }) => {
    const place = placeDialog(anchor, viewport);
    expect({
      side: place.side,
      left: place.left,
      top: place.top,
      width: place.width,
      height: place.height,
    }).toEqual(want);
  });

  it.each([
    { name: "a box in the middle", anchor: box(400, 300, 700, 450) },
    { name: "a box in a corner", anchor: box(0, 0, 100, 40) },
    { name: "a box outside the window", anchor: box(2000, 2000, 2300, 2100) },
    { name: "a box above the window", anchor: box(100, -900, 400, -700) },
    { name: "a box as big as the window", anchor: box(0, 0, 1280, 800) },
  ])("never leaves the window for $name", ({ anchor }) => {
    const viewport = { width: 1280, height: 800 };
    const place = placeDialog(anchor, viewport);
    expect(place.left).toBeGreaterThanOrEqual(8);
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.left + place.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(place.top + place.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(place.width).toBeLessThanOrEqual(DIALOG_WIDTH);
    expect(place.height).toBeLessThanOrEqual(DIALOG_HEIGHT);
  });
});
