import type { Clock } from "../core/clock";
import type { PromptChoice, PromptServer } from "../core/page-mode/messages";
import { Badge } from "./badge";
import { dimmedView } from "./badge-view";
import { badgeSpot } from "./badge-place";
import { OverlayHost } from "./overlay-host";
import { CLICK_GUARD_MS, PromptCard } from "./prompt-card";
import { deepActiveElement, type TextBoxFinder } from "./text-box-finder";

export interface SiteOfferDeps {
  /** The page's window. */
  win: Window & typeof globalThis;
  clock: Clock;
  /** The site's host name (`location.hostname`, or the host of the origin of a frame with no address). */
  host: string;
  finder: TextBoxFinder;
  /** `open` lets a test look inside the shadow root; the extension always uses `closed`. */
  overlayMode?: "closed" | "open";
  /** The user chose Turn on or Never in the card. The badge and the card are already gone. */
  onChoose: (choice: PromptChoice) => void;
}

/**
 * What page mode does on a site that is not on (`ask`, or `later`; SPEC section 4.11, "The badge and
 * the prompt"). It reads no text, makes no frame and sends nothing. It only listens for the focus
 * (trusted events only): an eligible text box that gets the focus gets the dimmed badge at its
 * bottom right corner, and the badge goes when the box loses the focus. A trusted click on the
 * badge, at least 500 ms after it appeared, opens the prompt card, anchored to the box; Turn on and
 * Never on this site are the choices, the close button and `Escape` just close the card. The
 * element in the page, with its closed shadow root, exists only while a badge is shown.
 */
export class SiteOffer {
  /** The server of the LLM in use for the card's note, updated when the background script says. */
  llm: PromptServer | null = null;
  private readonly deps: SiteOfferDeps;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private readonly listeners: (() => void)[] = [];
  private host: OverlayHost | undefined;
  private badge: Badge | undefined;
  private card: PromptCard | undefined;
  private box: HTMLElement | undefined;
  private shownAt = 0;
  private frame: number | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private started = false;

  constructor(deps: SiteOfferDeps) {
    this.deps = deps;
    this.win = deps.win;
    this.doc = deps.win.document;
  }

  /** Whether the card is showing. */
  get open(): boolean {
    return this.card?.isOpen === true;
  }

  /** Whether the dimmed badge is on the page. */
  get badgeShown(): boolean {
    return this.badge !== undefined;
  }

  /** The dimmed badge's button (for tests). */
  get badgeElement(): HTMLElement | undefined {
    return this.badge?.element;
  }

  /** The box the dimmed badge is on, if any. */
  get boxWithBadge(): HTMLElement | undefined {
    return this.box;
  }

  /**
   * Starts listening for the focus, and takes up the text box that already has it (an `autofocus`
   * box, or one a script focused before this began), if the document has the focus.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Only trusted events count: a page script can dispatch its own, but not make them trusted.
    // A script's own `element.focus()` is trusted, and counts like the user's.
    this.on(this.doc, "focusin", (event) => {
      if (event.isTrusted) this.onFocusIn(event as FocusEvent);
    });
    this.on(this.doc, "focusout", (event) => {
      if (event.isTrusted && this.host?.owns(event.target) !== true) this.clear();
    });
    this.on(this.doc, "keydown", (event) => {
      if (event.isTrusted && (event as KeyboardEvent).key === "Escape") this.closeCard();
    });
    this.on(this.doc, "input", (event) => {
      if (event.isTrusted) this.schedule();
    });
    this.on(this.win, "scroll", () => {
      this.schedule();
    });
    this.on(this.win, "resize", () => {
      this.schedule();
    });
    if (this.doc.hasFocus()) this.focusTarget(deepActiveElement(this.doc));
  }

  /** Stops listening and removes the badge, the card and their element from the page. */
  stop(): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.clear();
    this.started = false;
  }

  private on(target: EventTarget, type: string, handler: (event: Event) => void): void {
    const options = { capture: true, passive: true };
    target.addEventListener(type, handler, options);
    this.listeners.push(() => {
      target.removeEventListener(type, handler, options);
    });
  }

  private onFocusIn(event: FocusEvent): void {
    if (this.host?.owns(event.target) === true) return;
    this.focusTarget(event.composedPath()[0] ?? event.target);
  }

  private focusTarget(target: EventTarget | null): void {
    const inspection = this.deps.finder.find(target);
    if (inspection === undefined || "skip" in inspection) {
      // The focus is somewhere that is no text box page mode may use: the badge goes.
      this.clear();
      if (inspection?.transient === true) {
        this.deps.finder.retry(target, () => {
          this.focusTarget(target);
        });
      }
      return;
    }
    this.show(inspection.found.element);
  }

  private show(box: HTMLElement): void {
    if (this.box === box && this.badge !== undefined) {
      this.follow();
      return;
    }
    this.clear();
    this.host = new OverlayHost(this.doc, this.deps.overlayMode ?? "closed");
    this.box = box;
    this.badge = new Badge(this.doc, this.host.layer, () => {
      this.onBadge();
    });
    this.badge.show(dimmedView(this.deps.host));
    this.shownAt = this.deps.clock.now();
    if (typeof this.win.ResizeObserver === "function") {
      this.resizeObserver = new this.win.ResizeObserver(() => {
        this.schedule();
      });
      this.resizeObserver.observe(box);
    }
    this.follow();
  }

  /** A click on the dimmed badge opens the card, and a second click closes it. */
  private onBadge(): void {
    if (this.box === undefined || this.host === undefined) return;
    // A click in the first 500 ms after the badge appeared is the click that focused the box, or
    // an accident: it does nothing.
    if (this.deps.clock.now() - this.shownAt < CLICK_GUARD_MS) return;
    if (this.open) {
      this.closeCard();
      return;
    }
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
      onClose: () => {
        this.closeCard();
      },
    });
    this.card.place(this.box);
  }

  private closeCard(): void {
    this.card?.close();
    this.card = undefined;
  }

  private schedule(): void {
    if (this.frame !== undefined || this.box === undefined) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = undefined;
      this.follow();
    });
  }

  /** Puts the badge and the card where the box is now; a box that left the page loses them. */
  private follow(): void {
    const { box, badge } = this;
    if (box === undefined || badge === undefined) return;
    if (!box.isConnected) {
      this.clear();
      return;
    }
    const spot = badgeSpot(box, this.win);
    badge.place(spot.left, spot.top);
    badge.setVisible(spot.inView);
    if (this.card?.isOpen === true) this.card.place(box);
  }

  /** Removes the badge, the card and their element: nothing of page mode is left on the page. */
  private clear(): void {
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.closeCard();
    this.badge?.remove();
    this.badge = undefined;
    this.host?.remove();
    this.host = undefined;
    this.box = undefined;
  }
}
