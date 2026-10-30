import { categoryLabel } from "../core/analysis";
import type { IssueState, TextIssue } from "../core/issues";
import { el } from "./dom";
import { issueBoxes, issueIdAtPoint } from "./mirror";

/** The two lines of a tooltip: `<label> · <Category>`, then the issue's message. */
export function tooltipLines(issue: TextIssue): [string, string] {
  return [`${issue.type.label} · ${categoryLabel(issue.category)}`, issue.message];
}

/** Space between the pointer and the tooltip, and the least left to the window's edge. */
const OFFSET = 14;
const EDGE = 8;

/**
 * The tooltip of the underlines (SPEC section 4.3): one custom element, not `title`. Hovering an
 * underline shows `<label> · <Category>` and the message. The character under the mouse is found
 * from the mirror's span rectangles (`getClientRects`). Only shown categories have spans, so a
 * hidden category has no tooltip.
 */
export class IssueTooltip {
  static readonly ID = "issue-tooltip";

  private readonly doc: Document;
  private readonly textarea: HTMLTextAreaElement;
  private readonly mirror: HTMLElement;
  private readonly state: IssueState;
  private readonly tip: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly unsubscribe: () => void;
  private shown: number | null = null;

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
    this.title = el(doc, "strong", { class: "tip-title" });
    this.message = el(doc, "span", { class: "tip-message" });
    this.tip = el(
      doc,
      "div",
      { id: IssueTooltip.ID, class: "issue-tooltip", role: "tooltip", hidden: true },
      [this.title, this.message],
    );
    doc.body.append(this.tip);
    textarea.addEventListener("mousemove", this.onMove);
    for (const type of ["mouseleave", "mousedown", "keydown", "wheel", "scroll", "input"]) {
      textarea.addEventListener(type, this.hide);
    }
    this.unsubscribe = state.subscribe((change) => {
      if (change === "issues" || change === "visibility") this.hide();
    });
  }

  destroy(): void {
    this.textarea.removeEventListener("mousemove", this.onMove);
    for (const type of ["mouseleave", "mousedown", "keydown", "wheel", "scroll", "input"]) {
      this.textarea.removeEventListener(type, this.hide);
    }
    this.unsubscribe();
    this.tip.remove();
  }

  /** The id of the issue shown in the tooltip, or null. */
  get current(): number | null {
    return this.shown;
  }

  readonly hide = (): void => {
    if (this.shown === null) return;
    this.shown = null;
    this.tip.hidden = true;
    this.textarea.removeAttribute("aria-describedby");
  };

  private readonly onMove = (event: MouseEvent): void => {
    const id = issueIdAtPoint(issueBoxes(this.mirror), event.clientX, event.clientY);
    const issue = id === undefined ? undefined : this.state.visibleIssues.find((i) => i.id === id);
    if (issue === undefined) {
      this.hide();
      return;
    }
    if (this.shown !== issue.id) {
      const [title, message] = tooltipLines(issue);
      this.title.textContent = title;
      this.message.textContent = message;
      this.shown = issue.id;
      this.tip.hidden = false;
      this.textarea.setAttribute("aria-describedby", IssueTooltip.ID);
    }
    this.place(event.clientX, event.clientY);
  };

  /** Below and to the right of the pointer, moved inside the window when it would not fit. */
  private place(x: number, y: number): void {
    const view = this.doc.documentElement;
    const width = this.tip.offsetWidth;
    const height = this.tip.offsetHeight;
    const left = Math.max(EDGE, Math.min(x + OFFSET, view.clientWidth - width - EDGE));
    const below = y + OFFSET + height + EDGE <= view.clientHeight;
    const top = below ? y + OFFSET : Math.max(EDGE, y - OFFSET - height);
    this.tip.style.left = `${String(left)}px`;
    this.tip.style.top = `${String(top)}px`;
  }
}
