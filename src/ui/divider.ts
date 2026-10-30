/** Draggable divider between two panes. Sizes are CSS percentages kept in a custom property. */
export interface DividerOptions {
  /** The element that holds both panes and the custom property. */
  container: HTMLElement;
  /** `x` for a vertical divider (drag left and right), `y` for a horizontal one. */
  axis: "x" | "y";
  /** The custom property that holds the first pane's size, for example `--editor-share`. */
  property: string;
  min: number;
  max: number;
  /** Arrow key step, in percent. */
  step?: number;
}

export function clampPercent(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The first pane's share (in percent) when the pointer is at `position` in a box that starts at `start`. */
export function percentAt(
  position: number,
  start: number,
  size: number,
  min: number,
  max: number,
): number {
  if (size <= 0) return clampPercent(min, min, max);
  return clampPercent(((position - start) / size) * 100, min, max);
}

export function attachDivider(handle: HTMLElement, options: DividerOptions): void {
  const { container, axis, property, min, max } = options;
  const step = options.step ?? 2;

  const apply = (percent: number): void => {
    const value = clampPercent(percent, min, max);
    container.style.setProperty(property, `${String(value)}%`);
    handle.setAttribute("aria-valuenow", String(Math.round(value)));
  };

  const current = (): number => {
    const parsed = Number.parseFloat(container.style.getPropertyValue(property));
    if (!Number.isNaN(parsed)) return parsed;
    const fromAttribute = Number.parseFloat(handle.getAttribute("aria-valuenow") ?? "");
    return Number.isNaN(fromAttribute) ? min : fromAttribute;
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const rect = container.getBoundingClientRect();
    apply(
      axis === "x"
        ? percentAt(event.clientX, rect.left, rect.width, min, max)
        : percentAt(event.clientY, rect.top, rect.height, min, max),
    );
  });
  const stop = (event: PointerEvent): void => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove("dragging");
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);

  const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
  const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
  handle.addEventListener("keydown", (event) => {
    if (event.key === decrease) apply(current() - step);
    else if (event.key === increase) apply(current() + step);
    else return;
    event.preventDefault();
  });
}
