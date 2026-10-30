import type { ContentMessage } from "../core/page-mode/protocol";
import type { Box } from "../ui/mirror";
import type { FrameView } from "./frame-link";
import { placePopover, popoverRoom } from "./popover-place";
import type { BoxState } from "./box-state";
import type { BoxUnderlines } from "./underlines";

/** The text box a popover is for: its state and where its issues are drawn. */
export interface PopoverTarget {
  readonly state: BoxState;
  readonly underlines: BoxUnderlines;
}

export interface PopoverDeps {
  /** The frame the card is drawn by. */
  link: {
    post(message: ContentMessage): void;
    setView(view: FrameView | undefined): void;
  };
  /** The size of the window's visible area. */
  viewport(): { width: number; height: number };
  /** Called when the open issue changes or the popover goes, to draw the selected-issue background. */
  onChange(): void;
}

/** The popover that is open: the issue it explains, and what is known of its card. */
interface Open {
  readonly target: PopoverTarget;
  issue: number;
  /** The room the frame was told it has, in pixels. */
  maxHeight: number;
  /** The card's height as the frame reported it for this issue; undefined until then. */
  height: number | undefined;
  /** Which of the issue's lines the card is next to (the line that was clicked, or the first). */
  line: number;
}

/**
 * The explanation popover as the content script sees it (SPEC section 4.11): which issue of which
 * text box it is for, and where the card goes. The card itself, with the explanation and its
 * buttons, is drawn by the frame (`page-ui.html`): the content script never holds the LLM's
 * text. It tells the frame which issue to explain, and the frame tells it how high the card is;
 * the content script puts the frame's `<iframe>` just below the underline (above it when there is
 * no room) and keeps it there while the page scrolls.
 *
 * At most one popover is open on a page. Opening it for another issue switches the card.
 */
export class PopoverController {
  private readonly deps: PopoverDeps;
  private current: Open | undefined;

  constructor(deps: PopoverDeps) {
    this.deps = deps;
  }

  /** The text box and the issue of the open popover, or undefined. */
  get open(): { target: PopoverTarget; issue: number } | undefined {
    return this.current === undefined
      ? undefined
      : { target: this.current.target, issue: this.current.issue };
  }

  /** Whether a popover is open for this box. */
  isOpenFor(target: PopoverTarget): boolean {
    return this.current?.target === target;
  }

  /** The id of the issue the popover shows in this box, or null: it has the selected background. */
  selectedIn(target: PopoverTarget): number | null {
    return this.current?.target === target ? this.current.issue : null;
  }

  /**
   * Opens the popover for an issue, or switches it to that issue; nothing happens when it is
   * already showing it. `point` is where the user clicked, to choose the line of an issue that
   * wraps.
   */
  show(target: PopoverTarget, issue: number, point?: { x: number; y: number }): void {
    const rects = target.underlines.rectsOf(issue);
    if (rects.length === 0) return;
    const now = this.current;
    if (now?.target === target && now.issue === issue) return;
    const anchor = anchorFor(rects, point);
    const maxHeight = popoverRoom(anchor, this.deps.viewport());
    this.current = { target, issue, maxHeight, height: undefined, line: rects.indexOf(anchor) };
    this.deps.link.post({ type: "popover-open", box: target.state.id, issue, maxHeight });
    this.place();
    this.deps.onChange();
  }

  /**
   * Closes the popover and tells the frame (it drops the selection and cancels a running
   * explanation). Does nothing when none is open.
   */
  close(): void {
    const now = this.current;
    if (now === undefined) return;
    this.current = undefined;
    this.deps.link.post({ type: "popover-close", box: now.target.state.id });
    this.deps.link.setView(undefined);
    this.deps.onChange();
  }

  /** The frame closed it by itself (Escape in the card, Not an error): the frame already knows. */
  closedByFrame(box: number): boolean {
    if (this.current?.target.state.id !== box) return false;
    this.current = undefined;
    this.deps.link.setView(undefined);
    this.deps.onChange();
    return true;
  }

  /** The frame drew the card for an issue and it is `height` high. Sizes for another issue are late. */
  sized(box: number, issue: number, height: number): void {
    const now = this.current;
    if (now?.target.state.id !== box || now.issue !== issue) return;
    now.height = Math.min(height, now.maxHeight);
    this.place();
  }

  /** The text box is gone, or its text changed: the popover goes without a word to the frame. */
  forget(target: PopoverTarget): void {
    if (this.current?.target === target) this.close();
  }

  /**
   * Puts the card next to its underline again (the page scrolled or resized, or the box's issues
   * moved). It closes when the issue is gone or has scrolled out of the box.
   */
  place(): void {
    const now = this.current;
    if (now === undefined) return;
    const rects = now.target.underlines.rectsOf(now.issue);
    if (rects.length === 0) {
      // Edits and new check results remove the issue; a scroll can take it out of the box.
      this.close();
      return;
    }
    // Keep to the line that was clicked while it is still there; else the last one there is.
    const anchor = rects[Math.min(now.line, rects.length - 1)] ?? rects[0];
    if (anchor === undefined) return;
    const height = now.height ?? Math.min(now.maxHeight, 120);
    const place = placePopover(anchor, height, this.deps.viewport());
    this.deps.link.setView({
      left: place.left,
      top: place.top,
      width: place.width,
      height: place.height,
      visible: now.height !== undefined,
    });
  }
}

/** The rectangle of the issue's line that holds the point, else its first. */
export function anchorFor(rects: readonly Box[], point?: { x: number; y: number }): Box {
  const first = rects[0];
  if (first === undefined) throw new RangeError("an issue with no rectangle");
  if (point === undefined) return first;
  return (
    rects.find(
      (r) => point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom,
    ) ?? first
  );
}
