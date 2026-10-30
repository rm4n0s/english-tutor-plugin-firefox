import type { ContentMessage } from "../core/page-mode/protocol";
import type { BoxState } from "./box-state";
import { placeDialog } from "./dialog-place";
import type { FrameView } from "./frame-link";
import type { BoxUnderlines } from "./underlines";

/** The text box a dialog is for: its state and where its issues are drawn. */
export interface DialogTarget {
  readonly state: BoxState;
  readonly underlines: BoxUnderlines;
}

export interface DialogDeps {
  /** The frame the dialog is drawn by. */
  link: {
    post(message: ContentMessage): void;
    setView(view: FrameView | undefined): void;
  };
  /** The size of the window's visible area. */
  viewport(): { width: number; height: number };
  /** Called when the selected issue or the dialog changes, to draw the selected-issue background. */
  onChange(): void;
  /** Scrolls the issue into view in the box, without moving the caret (SPEC section 4.11). */
  reveal(target: DialogTarget, issue: number): void;
}

interface Open {
  readonly target: DialogTarget;
  /** The issue selected in the dialog's list, or null. */
  selected: number | null;
  /** The frame has drawn the dialog: it may be shown. */
  ready: boolean;
}

/**
 * The issues dialog as the content script sees it (SPEC section 4.11): which text box it is for,
 * where the frame is shown while it is open, and which issue is selected in its list. The dialog
 * itself, with the list, the explanation and the buttons, is drawn by the frame (`page-ui.html`):
 * the content script never holds the LLM's text. It tells the frame to open or close it, and the
 * frame says when it is drawn, which issue is selected, and when it closed itself.
 *
 * At most one dialog is open on a page. Opening it for another box replaces it. The popover and
 * the dialog share the frame, so the page opens one only after it has closed the other.
 */
export class DialogController {
  private readonly deps: DialogDeps;
  private current: Open | undefined;

  constructor(deps: DialogDeps) {
    this.deps = deps;
  }

  /** The text box and the selected issue of the open dialog, or undefined. */
  get open(): { target: DialogTarget; issue: number | null } | undefined {
    return this.current === undefined
      ? undefined
      : { target: this.current.target, issue: this.current.selected };
  }

  isOpenFor(target: DialogTarget): boolean {
    return this.current?.target === target;
  }

  /** The id of the issue selected in the dialog for this box, or null: it has the selected background. */
  selectedIn(target: DialogTarget): number | null {
    return this.current?.target === target ? this.current.selected : null;
  }

  /**
   * Opens the dialog for a box, or replaces the one that is open. `issue` is selected in its list
   * (the issue the popover showed when All issues was pressed). The frame stays hidden until it
   * has drawn the dialog.
   */
  show(target: DialogTarget, issue: number | null): void {
    this.current = { target, selected: null, ready: false };
    this.deps.link.post({ type: "dialog-open", box: target.state.id, issue });
    this.place();
    this.deps.onChange();
  }

  /** Closes the dialog and tells the frame (it drops the selection and cancels what it runs for it). */
  close(): void {
    const now = this.current;
    if (now === undefined) return;
    this.current = undefined;
    this.deps.link.post({ type: "dialog-close", box: now.target.state.id });
    this.deps.link.setView(undefined);
    this.deps.onChange();
  }

  /** The frame closed it by itself (Close, Escape in the dialog): the frame already knows. */
  closedByFrame(box: number): boolean {
    if (this.current?.target.state.id !== box) return false;
    this.current = undefined;
    this.deps.link.setView(undefined);
    this.deps.onChange();
    return true;
  }

  /** The frame drew the dialog: it is shown now. */
  drawn(box: number): void {
    const now = this.current;
    if (now?.target.state.id !== box) return;
    now.ready = true;
    this.place();
  }

  /**
   * The issue selected in the dialog's list changed. The box gets the selected background and,
   * for a new issue, scrolls it into view (the caret stays where it is).
   */
  selected(box: number, issue: number | null): void {
    const now = this.current;
    if (now?.target.state.id !== box || now.selected === issue) return;
    now.selected = issue;
    this.deps.onChange();
    if (issue !== null) this.deps.reveal(now.target, issue);
  }

  /** The text box is gone: the dialog goes without a word to the frame. */
  forget(target: DialogTarget): void {
    if (this.current?.target === target) this.close();
  }

  /** Puts the dialog next to its box again (the page scrolled or resized, or the box moved). */
  place(): void {
    const now = this.current;
    if (now === undefined) return;
    const rect = now.target.state.element.getBoundingClientRect();
    const place = placeDialog(rect, this.deps.viewport());
    this.deps.link.setView({
      left: place.left,
      top: place.top,
      width: place.width,
      height: place.height,
      visible: now.ready,
    });
  }
}
