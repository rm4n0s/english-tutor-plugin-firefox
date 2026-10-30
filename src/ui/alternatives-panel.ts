import { countCodePoints, takeCodePoints } from "../core/analysis";
import { el, setHidden, setText } from "./dom";

/** The most characters of the selected text the panel shows (SPEC section 4.6). */
export const SELECTED_PREVIEW_CHARS = 400;

export type AlternativesState = "closed" | "loading" | "ready" | "failed";

export interface AlternativesPanelHandlers {
  /** The user double-clicked a row or pressed Enter on it: replace the selection with `text`. */
  use(text: string): void;
  /** The user pressed Copy for the current row. */
  copy(text: string): void;
  /** The user pressed Retry after a failure. */
  retry(): void;
  /** The user pressed Close or Escape. */
  close(): void;
}

/** The selected text as the panel shows it: at most 400 characters, cut with "…". */
export function selectedPreview(text: string): string {
  return countCodePoints(text) <= SELECTED_PREVIEW_CHARS
    ? text
    : `${takeCodePoints(text, SELECTED_PREVIEW_CHARS)}…`;
}

/**
 * The Alternatives panel (SPEC section 4.6): a floating, non-modal panel inside the tutor page. It
 * shows the selected text, a state line and the alternatives, one row each, with Copy, Retry
 * (after a failure) and Close. It only draws what it is told and reports the user's actions
 * through the handlers; the page runs the request and the replacement. Every text is set with
 * `textContent`: alternatives come from the model and are untrusted (SPEC section 5.9).
 *
 * Showing it again replaces what it shows (one panel at a time). `close()` hides it without
 * calling the handlers.
 */
export class AlternativesPanel {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly handlers: AlternativesPanelHandlers;
  private readonly selected: HTMLElement;
  private readonly stateLine: HTMLElement;
  private readonly spinner: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private current: AlternativesState = "closed";
  private items: string[] = [];
  private index = 0;

  constructor(doc: Document, host: HTMLElement, handlers: AlternativesPanelHandlers) {
    this.doc = doc;
    this.handlers = handlers;
    this.selected = el(doc, "p", { class: "alt-selected", id: "alt-selected" });
    this.spinner = el(doc, "span", { class: "spinner spinner-small", "aria-hidden": "true" });
    this.stateLine = el(doc, "span", { class: "alt-state-text", id: "alt-state" });
    this.errorLine = el(doc, "p", { class: "alt-error", id: "alt-error", hidden: true });
    this.list = el(doc, "ul", {
      class: "alt-list",
      id: "alt-list",
      role: "listbox",
      tabindex: "0",
      "aria-label": "Alternatives",
    });
    this.note = el(doc, "p", { class: "alt-note", id: "alt-note", role: "status", hidden: true });
    this.copyButton = el(doc, "button", { type: "button", id: "alt-copy" }, ["Copy"]);
    this.retryButton = el(doc, "button", { type: "button", id: "alt-retry" }, ["Retry"]);
    const closeButton = el(doc, "button", { type: "button", id: "alt-close" }, ["Close"]);
    const x = el(
      doc,
      "button",
      { type: "button", class: "alt-x", id: "alt-x", "aria-label": "Close" },
      ["×"],
    );
    this.element = el(
      doc,
      "section",
      {
        class: "alternatives-panel",
        id: "alternatives",
        role: "dialog",
        "aria-label": "Alternatives",
        "aria-modal": "false",
        tabindex: "-1",
        "data-state": "closed",
        hidden: true,
      },
      [
        el(doc, "div", { class: "alt-head" }, [
          el(doc, "strong", { class: "alt-title" }, ["Alternatives for"]),
          x,
        ]),
        this.selected,
        el(doc, "div", { class: "alt-state", role: "status" }, [this.spinner, this.stateLine]),
        this.errorLine,
        this.list,
        this.note,
        el(doc, "div", { class: "alt-actions" }, [
          this.copyButton,
          this.retryButton,
          el(doc, "span", { class: "spacer" }),
          closeButton,
        ]),
      ],
    );
    host.append(this.element);

    closeButton.addEventListener("click", () => {
      this.handlers.close();
    });
    x.addEventListener("click", () => {
      this.handlers.close();
    });
    this.copyButton.addEventListener("click", () => {
      const text = this.items[this.index];
      if (text !== undefined) this.handlers.copy(text);
    });
    this.retryButton.addEventListener("click", () => {
      this.handlers.retry();
    });
    this.list.addEventListener("dblclick", (event) => {
      const row = this.rowOf(event.target);
      if (row === undefined) return;
      this.choose(row);
      this.handlers.use(this.items[row] ?? "");
    });
    this.list.addEventListener("click", (event) => {
      const row = this.rowOf(event.target);
      if (row !== undefined) this.choose(row);
    });
    this.list.addEventListener("keydown", (event) => {
      this.onListKey(event);
    });
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.handlers.close();
      }
    });
  }

  get state(): AlternativesState {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current !== "closed";
  }

  /** The text of the selected row, or undefined when there is none. */
  get selectedText(): string | undefined {
    return this.items[this.index];
  }

  /** The request starts for this text. Replaces anything the panel showed. */
  showLoading(selected: string): void {
    this.items = [];
    this.index = 0;
    this.list.replaceChildren();
    setText(this.selected, selectedPreview(selected));
    setText(this.stateLine, "Looking for alternatives...");
    this.setState("loading");
    this.clearNote();
    this.focusPanel();
  }

  showReady(alternatives: readonly string[]): void {
    this.items = [...alternatives];
    this.index = 0;
    this.list.replaceChildren(
      ...this.items.map((text, i) =>
        el(
          this.doc,
          "li",
          {
            class: "alt-row",
            id: `alt-row-${String(i)}`,
            role: "option",
            "data-index": String(i),
            "aria-selected": String(i === 0),
          },
          [text],
        ),
      ),
    );
    this.markSelection();
    const n = this.items.length;
    setText(
      this.stateLine,
      n === 0 ? "No alternatives found." : n === 1 ? "1 alternative" : `${String(n)} alternatives`,
    );
    this.setState("ready");
    this.clearNote();
    if (n > 0) this.list.focus();
  }

  showFailed(message: string): void {
    this.items = [];
    this.index = 0;
    this.list.replaceChildren();
    setText(this.stateLine, "Could not get alternatives.");
    setText(this.errorLine, message);
    this.setState("failed");
    this.clearNote();
    this.retryButton.focus();
  }

  /** A line under the list: why a replacement did not happen, or that Copy failed. */
  showNote(text: string): void {
    setText(this.note, text);
    setHidden(this.note, false);
  }

  clearNote(): void {
    setText(this.note, "");
    setHidden(this.note, true);
  }

  /** Hides the panel. It does not call the handlers (the page already knows). */
  close(): void {
    this.items = [];
    this.list.replaceChildren();
    this.setState("closed");
    this.clearNote();
  }

  destroy(): void {
    this.element.remove();
  }

  private setState(state: AlternativesState): void {
    this.current = state;
    this.element.dataset.state = state;
    setHidden(this.element, state === "closed");
    setHidden(this.spinner, state !== "loading");
    setHidden(this.errorLine, state !== "failed");
    setHidden(this.list, state !== "ready" || this.items.length === 0);
    this.copyButton.hidden = state !== "ready" || this.items.length === 0;
    this.retryButton.hidden = state !== "failed";
  }

  private focusPanel(): void {
    this.element.focus();
  }

  private rowOf(target: EventTarget | null): number | undefined {
    if (!(target instanceof Element)) return undefined;
    const row = target.closest<HTMLElement>(".alt-row");
    if (row === null) return undefined;
    const index = Number(row.dataset.index);
    return Number.isInteger(index) ? index : undefined;
  }

  private choose(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.index = index;
    this.markSelection();
  }

  private markSelection(): void {
    this.list.querySelectorAll<HTMLElement>(".alt-row").forEach((row, i) => {
      row.setAttribute("aria-selected", String(i === this.index));
    });
    this.list.setAttribute("aria-activedescendant", `alt-row-${String(this.index)}`);
  }

  private onListKey(event: KeyboardEvent): void {
    const last = this.items.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(this.index + 1, last);
    else if (event.key === "ArrowUp") next = Math.max(this.index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter") {
      event.preventDefault();
      const text = this.items[this.index];
      if (text !== undefined) this.handlers.use(text);
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    this.choose(next);
  }
}
