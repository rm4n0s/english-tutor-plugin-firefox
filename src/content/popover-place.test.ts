import { describe, expect, it } from "vitest";
import {
  placePopover,
  popoverRoom,
  POPOVER_GAP,
  POPOVER_MARGIN,
  POPOVER_MAX_HEIGHT,
  POPOVER_MIN_HEIGHT,
  POPOVER_WIDTH,
} from "./popover-place";

const VIEW = { width: 1280, height: 800 };
const anchor = (left: number, top: number, width = 40, height = 20) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("placePopover", () => {
  it.each([
    {
      name: "below the underline when there is room",
      anchor: anchor(300, 100),
      height: 200,
      view: VIEW,
      expected: { left: 300, top: 120 + POPOVER_GAP, side: "below", height: 200 },
    },
    {
      name: "above it when the card does not fit below",
      anchor: anchor(300, 650),
      height: 200,
      view: VIEW,
      expected: { left: 300, top: 650 - POPOVER_GAP - 200, side: "above", height: 200 },
    },
    {
      name: "below when it just fits",
      anchor: anchor(300, 100),
      height: 800 - 120 - POPOVER_GAP - POPOVER_MARGIN,
      view: VIEW,
      expected: { side: "below" },
    },
    {
      name: "above when it misses fitting below by one pixel",
      anchor: anchor(300, 400),
      height: 800 - 420 - POPOVER_GAP - POPOVER_MARGIN + 1,
      view: VIEW,
      expected: { side: "above" },
    },
    {
      name: "on the side with more room, cut to it, when it fits on neither (below)",
      anchor: anchor(300, 300),
      height: 700,
      view: VIEW,
      expected: { side: "below", height: 800 - 320 - POPOVER_GAP - POPOVER_MARGIN },
    },
    {
      name: "on the side with more room, cut to it, when it fits on neither (above)",
      anchor: anchor(300, 500),
      height: 700,
      view: VIEW,
      expected: { side: "above", height: 500 - POPOVER_GAP - POPOVER_MARGIN },
    },
    {
      name: "moved left to stay inside the window",
      anchor: anchor(1200, 100),
      height: 100,
      view: VIEW,
      expected: { left: 1280 - POPOVER_WIDTH - POPOVER_MARGIN },
    },
    {
      name: "moved right when the underline is at the window's edge",
      anchor: anchor(-30, 100),
      height: 100,
      view: VIEW,
      expected: { left: POPOVER_MARGIN },
    },
    {
      name: "narrower than 360 in a narrow window",
      anchor: anchor(50, 100),
      height: 100,
      view: { width: 300, height: 800 },
      expected: { left: POPOVER_MARGIN, width: 300 - 2 * POPOVER_MARGIN },
    },
  ])("puts the card $name", ({ anchor, height, view, expected }) => {
    expect(placePopover(anchor, height, view)).toMatchObject(expected);
  });

  it("never gives the card a negative height", () => {
    const place = placePopover(anchor(10, 395, 40, 10), 500, { width: 400, height: 420 });
    expect(place.height).toBeGreaterThanOrEqual(0);
  });
});

describe("popoverRoom", () => {
  it.each([
    { name: "lots of room below", anchor: anchor(0, 50), expected: POPOVER_MAX_HEIGHT },
    { name: "lots of room above", anchor: anchor(0, 700), expected: POPOVER_MAX_HEIGHT },
    {
      name: "a little room on both sides",
      anchor: anchor(0, 130),
      view: { width: 1280, height: 300 },
      expected: POPOVER_MIN_HEIGHT,
    },
    {
      name: "the larger side when neither has a full card",
      anchor: anchor(0, 250),
      view: { width: 1280, height: 600 },
      expected: 600 - 270 - POPOVER_GAP - POPOVER_MARGIN,
    },
  ])("is the most that fits with $name", ({ anchor, view, expected }) => {
    expect(popoverRoom(anchor, view ?? VIEW)).toBe(expected);
  });
});
