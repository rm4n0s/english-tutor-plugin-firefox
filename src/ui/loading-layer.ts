import type { Scheduler } from "../core/clock";
import type { IssueState } from "../core/issues";
import { el, setHidden } from "./dom";

/** After this long the layer adds the line about the notification (SPEC section 4.3). */
export const NOTIFY_AFTER_MS = 10_000;

/**
 * The loading layer of the editor (SPEC section 4.3): while a manual check runs, a translucent
 * layer covers the editor with "Checking..." and a busy indicator, the textarea is read-only, and
 * after 10 seconds the line "We will notify you when the results are ready." appears. An
 * auto-check shows nothing. The layer follows `IssueState.pending`.
 */
export class LoadingLayer {
  readonly element: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly state: IssueState;
  private readonly scheduler: Scheduler;
  private readonly unsubscribe: () => void;
  private cancelTimer: (() => void) | undefined;
  private shownFor: number | null = null;

  constructor(
    doc: Document,
    host: HTMLElement,
    textarea: HTMLTextAreaElement,
    state: IssueState,
    scheduler: Scheduler,
  ) {
    this.textarea = textarea;
    this.state = state;
    this.scheduler = scheduler;
    this.notice = el(doc, "p", { class: "loading-notice", hidden: true }, [
      "We will notify you when the results are ready.",
    ]);
    this.element = el(doc, "div", { id: "loading", class: "loading-layer", hidden: true }, [
      el(doc, "div", { class: "loading-box", role: "status" }, [
        el(doc, "div", { class: "spinner", "aria-hidden": "true" }),
        el(doc, "p", { class: "loading-text" }, ["Checking..."]),
        this.notice,
      ]),
    ]);
    host.append(this.element);
    this.unsubscribe = state.subscribe((change) => {
      if (change === "pending") this.update();
    });
    this.update();
  }

  destroy(): void {
    this.unsubscribe();
    this.cancelTimer?.();
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  private update(): void {
    const pending = this.state.pending;
    const id = pending?.manual === true ? pending.id : null;
    if (id === this.shownFor) return;
    this.shownFor = id;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    setHidden(this.notice, true);
    setHidden(this.element, id === null);
    this.textarea.readOnly = id !== null;
    if (id !== null) {
      this.cancelTimer = this.scheduler.after(NOTIFY_AFTER_MS, () => {
        setHidden(this.notice, false);
      });
    }
  }
}
