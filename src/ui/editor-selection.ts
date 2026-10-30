import { issueAt, type IssueState } from "../core/issues";
import { scrollDeltaToReveal } from "./reveal";

/** Space kept above and below an issue that is scrolled into view, in pixels. */
const REVEAL_MARGIN = 24;

/**
 * Keeps the editor's caret and scroll position in step with the shared selection (SPEC sections
 * 4.3 and 4.4). The editor and the list never talk to each other; both go through the `IssueState`.
 *
 * - The caret moving (click, keys) selects the issue under it, without moving the caret. Moving
 *   it outside all shown issues clears the selection.
 * - An issue selected from elsewhere (a row, `F7`) scrolls the editor to it and puts the caret at
 *   its start, without taking the keyboard focus. `focusSelected` also takes the focus, for
 *   double-click or Enter on a row.
 */
export class EditorSelection {
  private readonly textarea: HTMLTextAreaElement;
  private readonly mirror: HTMLElement;
  private readonly state: IssueState;
  private readonly unsubscribe: () => void;
  private fromCaret = false;

  constructor(textarea: HTMLTextAreaElement, mirror: HTMLElement, state: IssueState) {
    this.textarea = textarea;
    this.mirror = mirror;
    this.state = state;
    // `selectionchange` is the real signal; the others cover engines that fire it late.
    for (const type of ["selectionchange", "keyup", "mouseup", "focus", "select"]) {
      textarea.addEventListener(type, this.syncFromCaret);
    }
    this.unsubscribe = state.subscribe((change) => {
      if (change === "selection" && !this.fromCaret) this.reveal();
    });
  }

  destroy(): void {
    for (const type of ["selectionchange", "keyup", "mouseup", "focus", "select"]) {
      this.textarea.removeEventListener(type, this.syncFromCaret);
    }
    this.unsubscribe();
  }

  /** The caret's offset in the text. */
  get caret(): number {
    return this.textarea.selectionStart;
  }

  /** Selects the issue under the caret, or nothing when the caret is outside all of them. */
  readonly syncFromCaret = (): void => {
    const issue = issueAt(this.state.visibleIssues, this.textarea.selectionStart);
    this.fromCaret = true;
    try {
      this.state.select(issue?.id ?? null);
    } finally {
      this.fromCaret = false;
    }
  };

  /** Puts the caret at the start of the selected issue and scrolls the editor to it. */
  reveal(): void {
    const issue = this.state.selected;
    if (issue === undefined) return;
    this.textarea.setSelectionRange(issue.start, issue.start);
    const span = this.mirror.querySelector<HTMLElement>(
      `span.issue[data-issue-id="${String(issue.id)}"]`,
    );
    const rect = span?.getClientRects()[0];
    if (rect === undefined) return;
    const top = rect.top - this.mirror.getBoundingClientRect().top;
    const delta = scrollDeltaToReveal(top, top + rect.height, this.textarea.clientHeight, {
      margin: REVEAL_MARGIN,
      center: true,
    });
    if (delta !== 0) this.textarea.scrollTop += delta;
  }

  /** Moves the keyboard focus to the editor, caret at the start of the selected issue. */
  focusSelected(): void {
    this.reveal();
    this.textarea.focus({ preventScroll: true });
  }
}
