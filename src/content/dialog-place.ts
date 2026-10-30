import type { Box } from "../ui/mirror";
import { POPOVER_MARGIN as MARGIN } from "./popover-place";

/** The issues dialog is about this big, in CSS pixels (SPEC section 4.11). */
export const DIALOG_WIDTH = 440;
export const DIALOG_HEIGHT = 520;
/** Space between the text box and the dialog. */
export const DIALOG_GAP = 8;
/** The smallest the dialog is made to fit beside a box in a small window. */
export const DIALOG_MIN_WIDTH = 320;
export const DIALOG_MIN_HEIGHT = 260;

export interface DialogPlace {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly side: "right" | "left" | "below" | "above" | "over";
}

interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Where the issues dialog goes (SPEC section 4.11): next to the text box and inside the window.
 * It is 440 by 520 pixels (less in a smaller window). It goes to the right of the box when there
 * is room, else to its left, below it, or above it; the other coordinate follows the box and is
 * moved to stay `MARGIN` pixels inside the window. When no side has room for the whole dialog,
 * the side with the most room gets it, made smaller to fit if that is not below a minimum; when
 * even that does not fit (a box as big as the window) it covers the window's lower right corner.
 */
export function placeDialog(box: Box, viewport: Viewport): DialogPlace {
  // A box that is partly or wholly out of the window counts as the part of it that is in.
  const inside = (value: number, limit: number): number => Math.min(Math.max(value, 0), limit);
  const anchor: Box = {
    left: inside(box.left, viewport.width),
    top: inside(box.top, viewport.height),
    right: inside(box.right, viewport.width),
    bottom: inside(box.bottom, viewport.height),
  };
  const width = Math.max(0, Math.min(DIALOG_WIDTH, viewport.width - 2 * MARGIN));
  const height = Math.max(0, Math.min(DIALOG_HEIGHT, viewport.height - 2 * MARGIN));
  const clampLeft = (left: number, w: number): number =>
    Math.round(Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewport.width - w - MARGIN)));
  const clampTop = (top: number, h: number): number =>
    Math.round(Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewport.height - h - MARGIN)));

  const rightRoom = viewport.width - anchor.right - DIALOG_GAP - MARGIN;
  const leftRoom = anchor.left - DIALOG_GAP - MARGIN;
  const belowRoom = viewport.height - anchor.bottom - DIALOG_GAP - MARGIN;
  const aboveRoom = anchor.top - DIALOG_GAP - MARGIN;

  const sides = [
    {
      side: "right",
      room: rightRoom,
      need: width,
      place: (w: number, h: number): DialogPlace => ({
        left: Math.round(anchor.right + DIALOG_GAP),
        top: clampTop(anchor.top, h),
        width: w,
        height: h,
        side: "right",
      }),
    },
    {
      side: "left",
      room: leftRoom,
      need: width,
      place: (w: number, h: number): DialogPlace => ({
        left: Math.round(anchor.left - DIALOG_GAP - w),
        top: clampTop(anchor.top, h),
        width: w,
        height: h,
        side: "left",
      }),
    },
    {
      side: "below",
      room: belowRoom,
      need: height,
      place: (w: number, h: number): DialogPlace => ({
        left: clampLeft(anchor.left, w),
        top: Math.round(anchor.bottom + DIALOG_GAP),
        width: w,
        height: h,
        side: "below",
      }),
    },
    {
      side: "above",
      room: aboveRoom,
      need: height,
      place: (w: number, h: number): DialogPlace => ({
        left: clampLeft(anchor.left, w),
        top: Math.round(anchor.top - DIALOG_GAP - h),
        width: w,
        height: h,
        side: "above",
      }),
    },
  ] as const;

  const fits = sides.find((s) => s.room >= s.need);
  if (fits !== undefined) return fits.place(width, height);

  // No side has room for all of it: the roomiest side, made smaller, if that is not too small.
  const roomiest = sides.reduce((best, s) => (s.room > best.room ? s : best));
  const sideways = roomiest.side === "right" || roomiest.side === "left";
  const minimum = sideways ? DIALOG_MIN_WIDTH : DIALOG_MIN_HEIGHT;
  if (roomiest.room >= minimum) {
    const cut = Math.floor(roomiest.room);
    return roomiest.place(sideways ? cut : width, sideways ? height : cut);
  }
  return {
    left: clampLeft(viewport.width, width),
    top: clampTop(viewport.height, height),
    width,
    height,
    side: "over",
  };
}
