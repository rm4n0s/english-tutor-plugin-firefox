import type { Scheduler } from "../core/clock";

/** How often the boxes that have a badge are looked at (ms). */
export const LAYOUT_POLL_MS = 250;

export interface LayoutWatcherDeps {
  scheduler: Scheduler;
  /** The elements to watch now: the boxes that have a badge or underlines on the page. */
  elements: () => Iterable<Element>;
  /** At least one of them is somewhere else, or another size, than at the last look. */
  onMoved: () => void;
  /**
   * Called at each look, before the rectangles are compared, while there are boxes: page mode
   * re-reads the text of its `<textarea>` and `<input>` boxes here, because a script that sets
   * `value` fires no event (SPEC section 4.11). Its worst-case delay is this interval.
   */
  onTick?: () => void;
}

/**
 * Notices when a text box moves or changes size without any event that says so (SPEC section 4.11,
 * "Badge"): a modal that grows into place with a CSS transform (the box's own size does not change,
 * so no `ResizeObserver` fires), a page that moves its editor by changing a class, an animation.
 * Scrolling, resizing and the layout observers cover the rest. It looks at the boxes every 250 ms
 * while it runs, compares their rectangles with the last look, and calls `onMoved` when one is
 * different. Nothing is watched, and no timer runs, while there are no boxes.
 */
export class LayoutWatcher {
  private readonly deps: LayoutWatcherDeps;
  private readonly seen = new WeakMap<Element, string>();
  private cancel: (() => void) | undefined;

  constructor(deps: LayoutWatcherDeps) {
    this.deps = deps;
  }

  /** Whether the timer is running. */
  get running(): boolean {
    return this.cancel !== undefined;
  }

  /** Starts looking (a no-op when it already does). The boxes' current places count as seen. */
  start(): void {
    if (this.cancel !== undefined) return;
    this.look(false);
    this.arm();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  private arm(): void {
    this.cancel = this.deps.scheduler.after(LAYOUT_POLL_MS, () => {
      this.cancel = undefined;
      const any = !this.deps.elements()[Symbol.iterator]().next().done;
      // Nothing to watch: the timer stops until `start` is called again.
      if (!any) return;
      this.deps.onTick?.();
      this.look(true);
      this.arm();
    });
  }

  private look(report: boolean): void {
    let moved = false;
    for (const element of this.deps.elements()) {
      const rect = element.getBoundingClientRect();
      const key = [rect.left, rect.top, rect.width, rect.height].map((n) => n.toFixed(1)).join(",");
      if (this.seen.get(element) !== key) {
        this.seen.set(element, key);
        moved = true;
      }
    }
    if (moved && report) this.deps.onMoved();
  }
}
