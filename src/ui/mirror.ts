import type { Category } from "../core/analysis";
import type { IssueState } from "../core/issues";

/** A zero-width space (U+200B): it gives a trailing line break its last, empty line. */
const END_MARK = String.fromCharCode(0x200b);

/** What the mirror needs of an issue: the editor's `TextIssue` and page mode's `WireIssue` fit. */
export interface MirrorIssue {
  readonly id: number;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly category: Category;
}

/**
 * The nodes of the mirror layer: the text, with each shown issue wrapped in a
 * `<span class="issue issue-<category>">` (and `issue-selected` for the selected one). Issues that
 * do not fit the text (past its end, empty, or overlapping an earlier one) are skipped, so a
 * mirror drawn between an edit and the state catching up never throws or garbles the text.
 * A zero-width space at the end gives a text that ends in a line break its last, empty line, as
 * the textarea has it.
 */
export function mirrorNodes(
  doc: Document,
  text: string,
  issues: readonly MirrorIssue[],
  selectedId: number | null,
): Node[] {
  const nodes: Node[] = [];
  let cursor = 0;
  for (const issue of issues) {
    if (issue.start < cursor || issue.end <= issue.start || issue.end > text.length) continue;
    if (issue.start > cursor) nodes.push(doc.createTextNode(text.slice(cursor, issue.start)));
    const span = doc.createElement("span");
    span.className = `issue issue-${issue.category}${issue.id === selectedId ? " issue-selected" : ""}`;
    span.dataset.issueId = String(issue.id);
    span.textContent = text.slice(issue.start, issue.end);
    nodes.push(span);
    cursor = issue.end;
  }
  nodes.push(doc.createTextNode(`${text.slice(cursor)}${END_MARK}`));
  return nodes;
}

/** A rectangle in viewport coordinates, as `getClientRects` gives it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The rectangles of each shown issue's span in the mirror: one per line the issue covers. */
export function issueBoxes(mirror: HTMLElement): { id: number; boxes: Box[] }[] {
  const result: { id: number; boxes: Box[] }[] = [];
  for (const span of mirror.querySelectorAll<HTMLElement>("span.issue")) {
    const id = Number(span.dataset.issueId);
    if (Number.isInteger(id)) result.push({ id, boxes: [...span.getClientRects()] });
  }
  return result;
}

/**
 * The issue whose rectangles hold the point, or undefined (SPEC section 4.3: the character under
 * the mouse is found from the mirror's span rectangles).
 */
export function issueIdAtPoint(
  issues: readonly { id: number; boxes: readonly Box[] }[],
  x: number,
  y: number,
): number | undefined {
  return issues.find(({ boxes }) =>
    boxes.some((box) => x >= box.left && x < box.right && y >= box.top && y < box.bottom),
  )?.id;
}

/**
 * The layer behind a transparent `<textarea>` that draws the underlines (SPEC section 4.3). It has
 * the same font, padding, width, wrapping and scroll position as the textarea (they share the
 * CSS class `editor-text`), holds the text in transparent colour, and shows only the underlines of
 * the issue spans. It never changes the textarea's text or undo history.
 *
 * It redraws when the issues, the selection or the hidden categories change, and when the user
 * types; after a program sets `textarea.value` it must be told with `render()`.
 */
export class EditorMirror {
  private readonly doc: Document;
  private readonly textarea: HTMLTextAreaElement;
  private readonly mirror: HTMLElement;
  private readonly state: IssueState;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver | undefined;

  constructor(
    doc: Document,
    textarea: HTMLTextAreaElement,
    mirror: HTMLElement,
    state: IssueState,
  ) {
    this.doc = doc;
    this.textarea = textarea;
    this.mirror = mirror;
    this.state = state;
    textarea.addEventListener("scroll", this.sync);
    textarea.addEventListener("input", this.render);
    this.unsubscribe = state.subscribe((change) => {
      if (change === "issues" || change === "selection" || change === "visibility") this.render();
    });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.sync);
      this.resizeObserver.observe(textarea);
    }
    this.render();
  }

  destroy(): void {
    this.textarea.removeEventListener("scroll", this.sync);
    this.textarea.removeEventListener("input", this.render);
    this.unsubscribe();
    this.resizeObserver?.disconnect();
  }

  /** Redraws the text and the issue spans. */
  readonly render = (): void => {
    this.mirror.replaceChildren(
      ...mirrorNodes(
        this.doc,
        this.textarea.value,
        this.state.visibleIssues,
        this.state.selectedId,
      ),
    );
    this.sync();
  };

  /**
   * Gives the mirror the textarea's scroll position and the width its text area has: a scroll bar
   * takes room from the textarea's text, and the mirror's text must wrap at the same place.
   */
  readonly sync = (): void => {
    const bar = Math.max(0, this.textarea.offsetWidth - this.textarea.clientWidth);
    this.mirror.style.setProperty("--scrollbar-width", `${String(bar)}px`);
    this.mirror.scrollTop = this.textarea.scrollTop;
    this.mirror.scrollLeft = this.textarea.scrollLeft;
  };
}
