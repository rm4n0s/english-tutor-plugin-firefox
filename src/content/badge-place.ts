import { BADGE_SIZE } from "./badge";

/** Space between the badge and the box's inner corner. */
export const BADGE_MARGIN = 4;

export interface BadgeSpot {
  /** Window coordinates of the badge's top left corner. */
  left: number;
  top: number;
  /** Whether any part of the box is in the window: a box scrolled out of sight has no badge. */
  inView: boolean;
}

/**
 * Where the badge of a text box goes (SPEC section 4.11): at the bottom right inside the box's
 * border and its scroll bars. Used by the badge of a site that is on and by the dimmed badge.
 */
export function badgeSpot(element: HTMLElement, win: Window): BadgeSpot {
  const rect = element.getBoundingClientRect();
  const style = win.getComputedStyle(element);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
  const borderY = px(style.borderTopWidth) + px(style.borderBottomWidth);
  // The room of a scroll bar is not part of the text area either.
  const scrollbarX = Math.max(0, element.offsetWidth - element.clientWidth - borderX);
  const scrollbarY = Math.max(0, element.offsetHeight - element.clientHeight - borderY);
  return {
    left: rect.right - px(style.borderRightWidth) - scrollbarX - BADGE_SIZE - BADGE_MARGIN,
    top: rect.bottom - px(style.borderBottomWidth) - scrollbarY - BADGE_SIZE - BADGE_MARGIN,
    inView:
      rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth,
  };
}
