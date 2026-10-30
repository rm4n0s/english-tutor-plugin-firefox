import type { Box } from "../ui/mirror";

/** The popover is this wide, in CSS pixels (SPEC section 4.11). */
export const POPOVER_WIDTH = 360;
/** The tallest the popover gets; its explanation scrolls inside it. */
export const POPOVER_MAX_HEIGHT = 340;
/** The shortest room the popover is given, when the viewport is small. */
export const POPOVER_MIN_HEIGHT = 140;
/** Space between the underline and the card, and between the card and the window's edge. */
export const POPOVER_GAP = 6;
export const POPOVER_MARGIN = 8;

export interface PopoverPlace {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly side: "below" | "above";
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The most height a card next to `anchor` can have: the room below or above it, whichever is
 * larger, between the shortest and the tallest card.
 */
export function popoverRoom(anchor: Box, viewport: Viewport): number {
  const below = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  return Math.round(
    Math.min(POPOVER_MAX_HEIGHT, Math.max(POPOVER_MIN_HEIGHT, Math.max(below, above))),
  );
}

/**
 * Where the card goes (SPEC section 4.11): just below the underline, above it when it does not
 * fit below, and, when it fits on neither side, on the side with more room with its height cut to
 * that room. Its left edge is the underline's, moved to keep the whole card inside the window.
 */
export function placePopover(anchor: Box, height: number, viewport: Viewport): PopoverPlace {
  const width = Math.min(POPOVER_WIDTH, Math.max(0, viewport.width - 2 * POPOVER_MARGIN));
  const maxLeft = Math.max(POPOVER_MARGIN, viewport.width - width - POPOVER_MARGIN);
  const left = Math.round(Math.min(Math.max(anchor.left, POPOVER_MARGIN), maxLeft));
  const below = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
  if (height <= below) {
    return { left, top: Math.round(anchor.bottom + POPOVER_GAP), width, height, side: "below" };
  }
  if (height <= above) {
    return {
      left,
      top: Math.round(anchor.top - POPOVER_GAP - height),
      width,
      height,
      side: "above",
    };
  }
  if (below >= above) {
    const cut = Math.max(0, Math.round(below));
    return {
      left,
      top: Math.round(anchor.bottom + POPOVER_GAP),
      width,
      height: cut,
      side: "below",
    };
  }
  const cut = Math.max(0, Math.round(above));
  return {
    left,
    top: Math.round(anchor.top - POPOVER_GAP - cut),
    width,
    height: cut,
    side: "above",
  };
}
