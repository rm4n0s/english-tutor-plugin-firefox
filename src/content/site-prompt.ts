import type { Clock } from "../core/clock";
import type { PromptChoice, PromptServer } from "../core/page-mode/messages";
import { OverlayHost } from "./overlay-host";
import { PromptCard } from "./prompt-card";
import { findTextBox } from "./text-box";

export interface SitePromptDeps {
  /** The page's window. */
  win: Window & typeof globalThis;
  clock: Clock;
  /** The exact host name of the page (`location.hostname`). */
  host: string;
  /** `open` lets a test look inside the shadow root; the extension always uses `closed`. */
  overlayMode?: "closed" | "open";
  /** The card was opened: it is shown at most once per page load. */
  onShown: () => void;
  /** The user chose. The card is already closed. */
  onChoose: (choice: PromptChoice) => void;
}

/**
 * What page mode does on a site it has no choice for yet (SPEC section 4.11): it only listens for
 * the first trusted focus of a text box that page mode may read, and then shows the prompt card
 * under that box. It reads no text, makes no frame and sends nothing. The element in the page, with
 * its closed shadow root, exists only while the card is open.
 */
export class SitePrompt {
  private readonly deps: SitePromptDeps;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private readonly listeners: (() => void)[] = [];
  private host: OverlayHost | undefined;
  private card: PromptCard | undefined;
  private box: HTMLElement | undefined;
  private frame: number | undefined;
  private started = false;
  /** The server of the LLM in use for the card's note, updated when the background script says. */
  llm: PromptServer | null = null;

  constructor(deps: SitePromptDeps) {
    this.deps = deps;
    this.win = deps.win;
    this.doc = deps.win.document;
  }

  /** Whether the card is showing. */
  get open(): boolean {
    return this.card?.isOpen === true;
  }

  /** Starts listening for the focus. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const onFocusIn = (event: Event): void => {
      // Only trusted events count: a page script can dispatch its own, but not make them trusted.
      if (!event.isTrusted) return;
      if (this.host?.owns(event.target ?? null) === true) return;
      const found = findTextBox(event.composedPath()[0] ?? event.target, this.win);
      if (found !== undefined) this.show(found.element);
    };
    this.on(this.doc, "focusin", onFocusIn);
  }

  /** Stops listening and removes the card and its element from the page. */
  stop(): void {
    for (const remove of this.listeners.splice(0)) remove();
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.card?.close();
    this.card = undefined;
    this.host?.remove();
    this.host = undefined;
    this.box = undefined;
    this.started = false;
  }

  private on(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const options = { capture: true, passive: true };
    target.addEventListener(type, handler, options);
    this.listeners.push(() => {
      target.removeEventListener(type, handler, options);
    });
  }

  private show(box: HTMLElement): void {
    // The focus is not listened to any more: the card is shown at most once per page load.
    for (const remove of this.listeners.splice(0)) remove();
    this.deps.onShown();
    this.host = new OverlayHost(this.doc, this.deps.overlayMode ?? "closed");
    this.box = box;
    this.card = new PromptCard({
      doc: this.doc,
      layer: this.host.layer,
      clock: this.deps.clock,
      host: this.deps.host,
      llm: this.llm,
      onChoose: (choice) => {
        this.stop();
        this.deps.onChoose(choice);
      },
    });
    this.card.place(box);
    // The card follows the box while the page scrolls or changes size.
    const schedule = (): void => {
      if (this.frame !== undefined) return;
      this.frame = this.win.requestAnimationFrame(() => {
        this.frame = undefined;
        this.follow();
      });
    };
    this.on(this.win, "scroll", schedule);
    this.on(this.win, "resize", schedule);
  }

  private follow(): void {
    if (this.card === undefined || this.box === undefined) return;
    // The box left the page: nothing is left to ask about.
    if (!this.box.isConnected) this.stop();
    else this.card.place(this.box);
  }
}
