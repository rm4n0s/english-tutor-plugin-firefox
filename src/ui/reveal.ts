/** Geometry for scrolling something into view. No DOM, so it is tested on plain numbers. */

/**
 * How far to scroll (positive: the content moves up) so that an item whose top and bottom are
 * `top` and `bottom` (relative to the top of a view `viewHeight` high) is visible with `margin`
 * to spare. 0 when it already is. With `center`, an item that is not visible is put in the middle
 * of the view; otherwise it is moved just inside the nearest edge. An item taller than the view
 * is lined up at its top.
 */
export function scrollDeltaToReveal(
  top: number,
  bottom: number,
  viewHeight: number,
  options: { margin?: number; center?: boolean } = {},
): number {
  const margin = options.margin ?? 0;
  const height = bottom - top;
  const visible = top >= margin && bottom <= viewHeight - margin;
  if (visible) return 0;
  if (height + 2 * margin >= viewHeight) return top - margin;
  if (options.center === true) return top - (viewHeight - height) / 2;
  return top < margin ? top - margin : bottom - (viewHeight - margin);
}

/** Scrolls `container` just enough that `element` (a descendant) is inside its view. */
export function scrollElementIntoView(container: HTMLElement, element: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const delta = scrollDeltaToReveal(
    rect.top - box.top,
    rect.bottom - box.top,
    container.clientHeight,
  );
  if (delta !== 0) container.scrollTop += delta;
}
