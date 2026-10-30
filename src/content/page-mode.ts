import type { Clock, Scheduler } from "../core/clock";
import type { AppError } from "../core/errors";
import type { Logger } from "../core/log";
import type {
  PageBroadcast,
  PromptChoice,
  PromptServer,
  SiteConfig,
} from "../core/page-mode/messages";
import { PAGE_MODE_OFF } from "../core/page-mode/messages";
import type { FrameMessage } from "../core/page-mode/protocol";
import type { Random } from "../core/random";
import type { PageModeRuntime } from "../platform/page-mode";
import type { PageConnector } from "../platform/page-port";
import { Badge } from "./badge";
import { badgeSpot } from "./badge-place";
import { badgeViewOf } from "./badge-view";
import { BlockedCard } from "./blocked-card";
import { BoxState } from "./box-state";
import { DialogController } from "./dialog";
import { FrameLink } from "./frame-link";
import { issueAt } from "../core/issues/navigation";
import { LayoutWatcher } from "./layout-watch";
import { OverlayHost } from "./overlay-host";
import { PopoverController, type PopoverTarget } from "./popover";
import { SiteOffer } from "./site-offer";
import { siteHostOf } from "./site-host";
import { findTextBox } from "./text-box";
import { deepActiveElement, TextBoxFinder } from "./text-box-finder";
import { BoxUnderlines } from "./underlines";

export interface PageModeContentDeps {
  /** The page's window. */
  win: Window & typeof globalThis;
  runtime: PageModeRuntime;
  connector: PageConnector;
  scheduler: Scheduler;
  /** Time for the prompt: its buttons ignore clicks in its first 500 ms. */
  clock: Clock;
  random: Random;
  log: Logger;
  /** `open` lets a test look inside the shadow root; the extension always uses `closed`. */
  overlayMode?: "closed" | "open";
  frameTimeoutMs?: number;
}

interface Tracked {
  state: BoxState;
  badge: Badge;
  underlines: BoxUnderlines;
}

/**
 * Page mode on one web page, in one frame of it (SPEC section 4.11). It asks the background script
 * what page mode does on this host, and acts on the answer:
 *
 * - `on`: it watches focus. A text box takes part only after the user focuses it (events the page
 *   dispatches itself, `isTrusted === false`, are ignored). It keeps the box's text state, sends
 *   the text and each edit to the frame over the port, and draws the badge from what the frame
 *   answers.
 * - `ask` and `later`: it reads no text and makes no frame. A text box page mode may read that gets
 *   the focus gets the dimmed badge; a click on it opens the prompt card; Turn on makes the site
 *   `on` and checks the focused box at once.
 * - `off`: it does nothing at all: no badge, no listener, no element.
 *
 * Everything it adds to the page is in an element with a closed shadow root. It never calls an LLM
 * and never sees a key or a setting. `page-mode-off` removes everything; `settings-changed` asks
 * the background script again.
 */
export class PageModeContent {
  private readonly deps: PageModeContentDeps;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private readonly finder: TextBoxFinder;
  private active: Active | undefined;
  private offer: SiteOffer | undefined;
  private stopListening: (() => void) | undefined;
  private asks = 0;

  constructor(deps: PageModeContentDeps) {
    this.deps = deps;
    this.win = deps.win;
    this.doc = deps.win.document;
    this.finder = new TextBoxFinder({
      win: deps.win,
      scheduler: deps.scheduler,
      log: deps.log,
      host: siteHostOf(deps.win),
    });
  }

  /** The site this frame belongs to (`siteHostOf`). */
  private get siteHost(): string {
    return siteHostOf(this.win);
  }

  /** Whether page mode is checking text boxes on this page now (the site is `on`). */
  get running(): boolean {
    return this.active !== undefined;
  }

  /** Whether the site is not on and page mode is waiting for a focus (the dimmed badge). */
  get asking(): boolean {
    return this.offer !== undefined;
  }

  /** Whether the prompt card is showing. */
  get promptOpen(): boolean {
    return this.offer?.open === true;
  }

  /** The text box that has the dimmed badge, if any. */
  get boxWithBadge(): HTMLElement | undefined {
    return this.offer?.boxWithBadge;
  }

  /** The dimmed badge of a site that is not on, if one is on the page. */
  get dimmedBadge(): HTMLElement | undefined {
    return this.offer?.badgeShown === true ? this.offer.badgeElement : undefined;
  }

  /** The text boxes the user has focused, with their state (for tests and for step 14). */
  get boxes(): readonly BoxState[] {
    return this.active === undefined ? [] : [...this.active.boxes.values()].map((t) => t.state);
  }

  /** Puts every badge where its box is now (a test, or a layout change the observers missed). */
  reposition(): void {
    this.active?.position();
  }

  /** The underlines of a box, if it has any (for tests). */
  underlinesOf(box: BoxState): BoxUnderlines | undefined {
    return this.active?.byId.get(box.id)?.underlines;
  }

  /** The issue the popover is open for, with its box, or undefined. */
  get popover(): { box: BoxState; issue: number } | undefined {
    const open = this.active?.popover.open;
    return open === undefined ? undefined : { box: open.target.state, issue: open.issue };
  }

  /** The issue selected in the issues dialog, with its box, or undefined when the dialog is closed. */
  get dialog(): { box: BoxState; issue: number | null } | undefined {
    const open = this.active?.dialog.open;
    return open === undefined ? undefined : { box: open.target.state, issue: open.issue };
  }

  /** The badge of a box, if it has one. */
  badgeOf(box: BoxState): Badge | undefined {
    return this.active?.byId.get(box.id)?.badge;
  }

  /** The error of a blocked frame, or undefined. */
  get blocked(): AppError | undefined {
    return this.active?.blocked;
  }

  /** Listens to the background script and asks it whether page mode runs here. */
  async start(): Promise<void> {
    if (this.stopListening === undefined) {
      const stopBroadcast = this.deps.runtime.onBroadcast((message) => {
        this.onBroadcast(message);
      });
      // The page goes away: its frame and port go with it. A page restored from the back/forward
      // cache asks again.
      const onHide = (): void => {
        this.asks++;
        this.detach();
      };
      const onShow = (event: PageTransitionEvent): void => {
        if (event.persisted) this.onBroadcast("settings-changed");
      };
      this.win.addEventListener("pagehide", onHide);
      this.win.addEventListener("pageshow", onShow);
      this.stopListening = () => {
        stopBroadcast();
        this.win.removeEventListener("pagehide", onHide);
        this.win.removeEventListener("pageshow", onShow);
      };
    }
    await this.refresh();
  }

  /** Removes everything and stops listening. */
  destroy(): void {
    this.stopListening?.();
    this.stopListening = undefined;
    this.asks++;
    this.detach();
  }

  private onBroadcast(message: PageBroadcast): void {
    if (message === PAGE_MODE_OFF) {
      // Page mode is off: remove everything at once, without asking.
      this.asks++;
      this.detach();
      return;
    }
    this.refresh().catch((err: unknown) => {
      this.deps.log.error("page mode could not ask whether it runs here", { err });
    });
  }

  /** Asks again; the latest answer wins. */
  private async refresh(): Promise<void> {
    const ask = ++this.asks;
    // An answer that cannot be had is `off`: nothing is read.
    let config: SiteConfig = { state: "off" };
    try {
      config = await this.deps.runtime.configFor(this.siteHost);
    } catch (err) {
      this.deps.log.error("page mode could not ask what it does here", { err });
    }
    if (ask !== this.asks) return;
    this.apply(config);
  }

  private apply(config: SiteConfig): void {
    const host = this.siteHost;
    this.deps.log.debug(
      `page mode is ${config.state} on ${host === "" ? "a frame with no site" : host}`,
    );
    if (config.state === "on") {
      this.dropOffer();
      const first = this.active === undefined;
      this.attach();
      // A box that is already focused (autofocus, or a script focused it before this began) is
      // taken up as if it had just been focused, but only if the user is in this document.
      if (first && this.doc.hasFocus()) this.active?.adopt(deepActiveElement(this.doc));
    } else if (!("llm" in config)) {
      this.detach();
    } else {
      // `ask` or `later`: the dimmed badge. An open card stays: the answer only says the site is
      // still undecided.
      this.detachActive();
      this.offerOnFocus(config.llm);
    }
  }

  /** Starts listening for the focus, to show the dimmed badge (SPEC section 4.11). */
  private offerOnFocus(llm: PromptServer | null): void {
    if (this.offer === undefined) {
      this.offer = new SiteOffer({
        win: this.win,
        clock: this.deps.clock,
        host: this.siteHost,
        finder: this.finder,
        scheduler: this.deps.scheduler,
        ...(this.deps.overlayMode === undefined ? {} : { overlayMode: this.deps.overlayMode }),
        onChoose: (choice) => {
          this.offer = undefined;
          this.choose(choice);
        },
      });
      this.offer.llm = llm;
      this.offer.start();
    } else {
      this.offer.llm = llm;
    }
  }

  /** The user's choice in the prompt: sent to the background script, which stores it. */
  private choose(choice: PromptChoice): void {
    this.asks++;
    this.finishChoose(choice).catch((err: unknown) => {
      this.deps.log.error("page mode could not store the choice", { err });
    });
  }

  private async finishChoose(choice: PromptChoice): Promise<void> {
    await this.deps.runtime.chooseSite(this.siteHost, choice);
    if (choice !== "on") return;
    // Turn on: the site is on at once. The box the user is in is checked now, not after the next
    // focus.
    this.attach();
    this.active?.adopt(deepActiveElement(this.doc));
  }

  private attach(): void {
    if (this.active !== undefined) return;
    this.active = new Active(this.deps, this.win, this.doc, this.finder);
  }

  private dropOffer(): void {
    this.offer?.stop();
    this.offer = undefined;
  }

  private detachActive(): void {
    this.active?.destroy();
    this.active = undefined;
  }

  /** Removes everything page mode has on the page: the checks, the badges and the prompt. */
  private detach(): void {
    this.detachActive();
    this.dropOffer();
    this.finder.cancel();
  }
}

/** Everything page mode has on the page while it runs. Made by `attach`, gone with `destroy`. */
class Active {
  readonly boxes = new Map<HTMLElement, Tracked>();
  readonly byId = new Map<number, Tracked>();
  blocked: AppError | undefined;
  private readonly deps: PageModeContentDeps;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private readonly host: OverlayHost;
  private readonly link: FrameLink;
  private readonly card: BlockedCard;
  readonly popover: PopoverController;
  readonly dialog: DialogController;
  private readonly listeners: (() => void)[] = [];
  private readonly finder: TextBoxFinder;
  private focused: Tracked | undefined;
  /** Whether the keyboard focus is inside the popover's frame (the page sees a focus on our host). */
  private cardFocused = false;
  private nextId = 1;
  private frame: number | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private mutationObserver: MutationObserver | undefined;
  private readonly layout: LayoutWatcher;

  constructor(
    deps: PageModeContentDeps,
    win: Window & typeof globalThis,
    doc: Document,
    finder: TextBoxFinder,
  ) {
    this.deps = deps;
    this.win = win;
    this.doc = doc;
    this.finder = finder;
    this.layout = new LayoutWatcher({
      scheduler: deps.scheduler,
      elements: () => [...this.boxes.keys()],
      onMoved: () => {
        this.schedulePosition();
      },
    });
    this.host = new OverlayHost(doc, deps.overlayMode ?? "closed");
    this.card = new BlockedCard(doc, this.host.layer);
    this.link = new FrameLink(
      {
        doc,
        parent: this.host.layer,
        connector: deps.connector,
        frameUrl: (id) => deps.runtime.frameUrl(id),
        register: (id) => deps.runtime.registerFrame(id),
        scheduler: deps.scheduler,
        random: deps.random,
        log: deps.log,
        ...(deps.frameTimeoutMs === undefined ? {} : { timeoutMs: deps.frameTimeoutMs }),
      },
      {
        onReady: () => undefined,
        onMessage: (message) => {
          this.onFrameMessage(message);
        },
        onBlocked: (error) => {
          this.blocked = error;
          this.card.close();
          this.popover.close();
          this.dialog.close();
          for (const tracked of this.boxes.values()) this.render(tracked);
        },
      },
    );
    const viewport = (): { width: number; height: number } => ({
      width: this.doc.documentElement.clientWidth || this.win.innerWidth,
      height: this.doc.documentElement.clientHeight || this.win.innerHeight,
    });
    const redraw = (): void => {
      for (const tracked of this.boxes.values()) this.drawUnderlines(tracked);
    };
    this.popover = new PopoverController({ link: this.link, viewport, onChange: redraw });
    // The issues dialog (SPEC section 4.11) is drawn by the same frame as the popover, so the page
    // opens one only after it has closed the other.
    this.dialog = new DialogController({
      link: this.link,
      viewport,
      onChange: redraw,
      reveal: (target, issue) => {
        target.underlines.reveal(issue);
      },
    });
    this.listen();
  }

  // Events

  private listen(): void {
    const on = (
      target: EventTarget,
      type: string,
      handler: (event: Event) => void,
      options: AddEventListenerOptions = { capture: true, passive: true },
    ): void => {
      target.addEventListener(type, handler, options);
      this.listeners.push(() => {
        target.removeEventListener(type, handler, options);
      });
    };
    // Only trusted events count: a page script can dispatch its own, but not make them trusted.
    on(this.doc, "focusin", (event) => {
      if (event.isTrusted) this.onFocusIn(event as FocusEvent);
    });
    on(this.doc, "focusout", (event) => {
      if (event.isTrusted) this.onFocusOut(event as FocusEvent);
    });
    on(this.doc, "input", (event) => {
      if (event.isTrusted) this.onInput(event);
    });
    // The popover (SPEC section 4.11): a click in an issue opens it, the caret moving to another
    // issue switches it, and Escape, a click elsewhere or typing closes it.
    on(this.doc, "mousedown", (event) => {
      if (event.isTrusted) this.onMouseDown(event as MouseEvent);
    });
    on(this.doc, "mouseup", (event) => {
      if (event.isTrusted) this.onMouseUp(event as MouseEvent);
    });
    on(this.doc, "keydown", (event) => {
      if (event.isTrusted && (event as KeyboardEvent).key === "Escape") {
        this.closePopover(true);
        this.closeDialog(true);
      }
    });
    for (const type of ["keyup", "selectionchange", "select"]) {
      on(this.doc, type, (event) => {
        if (event.isTrusted) this.onCaretMoved();
      });
    }
    // Following a box: scrolling anywhere, resizing, and layout changes.
    on(this.win, "scroll", () => {
      this.schedulePosition();
    });
    on(this.win, "resize", () => {
      this.schedulePosition();
    });
    // A modal that grows into place, a box that slides: the end of the movement is exact.
    for (const type of ["transitionend", "animationend"]) {
      on(this.doc, type, () => {
        this.schedulePosition();
      });
    }
  }

  /**
   * Watches the page for layout changes, once there is a box to follow: a page where the user never
   * focuses a text box has no observer at all.
   */
  private observe(): void {
    if (this.mutationObserver !== undefined || this.resizeObserver !== undefined) return;
    if (typeof this.win.MutationObserver === "function") {
      this.mutationObserver = new this.win.MutationObserver(() => {
        this.schedulePosition();
      });
      this.mutationObserver.observe(this.doc.documentElement, { childList: true, subtree: true });
    }
    if (typeof this.win.ResizeObserver === "function") {
      this.resizeObserver = new this.win.ResizeObserver(() => {
        this.schedulePosition();
      });
    }
  }

  private onFocusIn(event: FocusEvent): void {
    // The focus went into the popover's own frame (the event looks like it came from our host), or
    // somewhere else: the popover stays only for the first, and for the box it belongs to.
    this.cardFocused = this.host.owns(event.target);
    this.focusTarget(event.composedPath()[0] ?? event.target, event.target);
    if (!this.cardFocused) this.closePopoverIfFocusLeft();
  }

  /**
   * Takes the text box the user is in right now, as if it had just been focused: after Turn on in
   * the prompt, the box is checked at once, not after the next focus.
   */
  adopt(target: Element | null): void {
    if (target === null) return;
    // The box is already the focused one (the announcement of the choice arrived first).
    if (this.focused?.state.element === target) return;
    this.focusTarget(target, target);
  }

  private focusTarget(target: EventTarget | null, eventTarget: EventTarget | null): void {
    if (this.host.owns(eventTarget)) return;
    const inspection = this.finder.find(target);
    if (inspection === undefined || "skip" in inspection) {
      this.deactivate();
      // A box that cannot be used yet (a modal that is still fading in) is looked at again.
      if (inspection?.transient === true) {
        this.finder.retry(target, () => {
          this.focusTarget(target, eventTarget);
        });
      }
      return;
    }
    const found = inspection.found;
    if (this.focused?.state.element !== found.element) this.deactivate();
    let tracked = this.boxes.get(found.element);
    if (tracked === undefined) {
      const state = new BoxState(
        this.nextId++,
        found.element,
        found.kind,
        `session:${this.deps.random.uuid()}`,
        this.win,
      );
      const underlines = new BoxUnderlines(this.doc, this.host.layer, state, this.win);
      const badge = new Badge(this.doc, this.host.layer, () => {
        this.onBadge(state);
      });
      badge.setVisible(false);
      tracked = { state, badge, underlines };
      this.boxes.set(found.element, tracked);
      this.byId.set(state.id, tracked);
      this.observe();
      this.resizeObserver?.observe(found.element);
      this.layout.start();
      this.link.start();
    } else {
      // The text may have changed while the box was not focused (a script wrote to it).
      this.syncBox(tracked.state);
    }
    this.focused = tracked;
    tracked.state.focused = true;
    this.link.post({
      type: "focus",
      box: tracked.state.id,
      source: tracked.state.source,
      revision: tracked.state.revision,
      text: tracked.state.text,
    });
    this.render(tracked);
  }

  private onFocusOut(event: FocusEvent): void {
    if (this.host.owns(event.target)) return;
    const found = findTextBox(event.composedPath()[0] ?? event.target, this.win);
    const focused = this.focused;
    if (focused === undefined) return;
    // A box that is no longer a text box (hidden, made read-only) still loses the focus.
    if (found === undefined || found.element === focused.state.element) this.deactivate();
    // The focus left the box: the popover stays only if it went into the popover's own frame.
    this.deps.scheduler.after(0, () => {
      this.closePopoverIfFocusLeft();
    });
  }

  private onInput(event: Event): void {
    const found = findTextBox(event.composedPath()[0] ?? event.target, this.win);
    if (found === undefined) {
      // A box that is no longer one (made read-only, hidden) is dropped; one never focused is not ours.
      const target = event.target as HTMLElement | null;
      const tracked = target === null ? undefined : this.boxes.get(target);
      if (tracked !== undefined) this.forget(tracked);
      return;
    }
    const tracked = this.boxes.get(found.element);
    if (tracked === undefined) return;
    // Typing closes the popover, before the underlines are drawn for the new text.
    this.popover.forget(tracked);
    this.syncBox(tracked.state);
    this.render(tracked);
  }

  // The popover

  private onMouseDown(event: MouseEvent): void {
    const open = this.popover.open;
    if (open === undefined || this.host.owns(event.target)) return;
    const target = event.composedPath()[0] ?? event.target;
    // A press in the same box is judged on release, by where the caret and the point are.
    if (
      target !== null &&
      "nodeType" in target &&
      open.target.state.element.contains(target as Node)
    ) {
      return;
    }
    this.popover.close();
  }

  private onMouseUp(event: MouseEvent): void {
    if (this.host.owns(event.target) || this.blocked !== undefined) return;
    const found = findTextBox(event.composedPath()[0] ?? event.target, this.win);
    const tracked = found === undefined ? undefined : this.boxes.get(found.element);
    if (tracked === undefined) return;
    this.evaluate(tracked, { x: event.clientX, y: event.clientY });
  }

  private onCaretMoved(): void {
    const open = this.popover.open;
    if (open === undefined || this.focused?.state !== open.target.state) return;
    this.evaluate(open.target, undefined);
  }

  /**
   * Looks at where the user is in the box: a click whose point is in an issue's underline, or
   * whose caret is in an issue, opens the popover for it (or switches it). With the popover
   * open, the caret moving to another issue switches it, and moving out of every issue closes it.
   */
  private evaluate(tracked: PopoverTarget, point: { x: number; y: number } | undefined): void {
    if (this.blocked !== undefined) return;
    const { state } = tracked;
    const open = this.popover.isOpenFor(tracked);
    let id = point === undefined ? undefined : tracked.underlines.issueAt(point.x, point.y);
    if (id === undefined) {
      const caret = this.caretOf(tracked);
      id = caret === undefined ? undefined : issueAt(state.issues, caret)?.id;
    }
    if (id === undefined) {
      if (open) this.popover.close();
      return;
    }
    if (point !== undefined || open) {
      // The dialog and the popover share the frame: the popover opens only after the dialog closed.
      if (tracked.underlines.rectsOf(id).length > 0) this.closeDialog(false);
      this.popover.show(tracked, id, point);
    }
  }

  /** The offset of the caret (the start of the selection) in the box's text. */
  private caretOf(tracked: PopoverTarget): number | undefined {
    const { element, kind, model } = tracked.state;
    if (kind !== "editable") {
      return (element as HTMLInputElement | HTMLTextAreaElement).selectionStart ?? undefined;
    }
    const selection = this.win.getSelection();
    if (selection === null || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer)) return undefined;
    return model?.offsetOf(range.startContainer, range.startOffset);
  }

  /** Closes the popover; after Escape the box gets the focus back if it was in the card. */
  private closePopover(restoreFocus: boolean): void {
    const open = this.popover.open;
    if (open === undefined) return;
    this.popover.close();
    if (restoreFocus) this.restoreFocus(open.target.state.element);
  }

  /** Closes the issues dialog; after Escape the box gets the focus back if it was in the dialog. */
  private closeDialog(restoreFocus: boolean): void {
    const open = this.dialog.open;
    if (open === undefined) return;
    this.dialog.close();
    if (restoreFocus) this.restoreFocus(open.target.state.element);
  }

  /** Opens the issues dialog for a box, with `issue` selected in it (All issues in the popover). */
  private openDialog(tracked: Tracked, issue: number | null): void {
    if (this.blocked !== undefined) return;
    this.popover.close();
    this.dialog.show(tracked, issue);
  }

  private restoreFocus(element: HTMLElement): void {
    if (this.doc.activeElement === this.host.element) element.focus({ preventScroll: true });
  }

  /** After the focus left a text box: the popover goes unless the focus is in its card. */
  private closePopoverIfFocusLeft(): void {
    const open = this.popover.open;
    if (open === undefined) return;
    if (this.cardFocused) return;
    const active = this.doc.activeElement;
    const element = open.target.state.element;
    if (active === this.host.element || active === element) return;
    if (active !== null && element.contains(active)) return;
    this.popover.close();
  }

  /** Reads the box; an edit goes to the frame. */
  private syncBox(state: BoxState): void {
    const found = state.sync();
    if (found === undefined) return;
    this.link.post({
      type: "edit",
      box: state.id,
      revision: state.revision,
      start: found.edit.start,
      removed: found.edit.removed,
      inserted: found.inserted,
    });
  }

  private deactivate(): void {
    const tracked = this.focused;
    if (tracked === undefined) return;
    this.focused = undefined;
    tracked.state.focused = false;
    this.link.post({ type: "blur", box: tracked.state.id });
    this.render(tracked);
  }

  private forget(tracked: Tracked): void {
    this.boxes.delete(tracked.state.element);
    this.byId.delete(tracked.state.id);
    this.resizeObserver?.unobserve(tracked.state.element);
    if (this.focused === tracked) this.focused = undefined;
    this.popover.forget(tracked);
    this.dialog.forget(tracked);
    this.link.post({ type: "forget", box: tracked.state.id });
    tracked.underlines.remove();
    tracked.badge.remove();
  }

  // The frame

  private onFrameMessage(message: FrameMessage): void {
    if (message.type === "state") {
      const tracked = this.byId.get(message.box);
      if (tracked === undefined) return;
      // A state for an older revision is dropped: the frame answers again once it has seen the
      // latest edit.
      if (!tracked.state.apply(message)) return;
      this.render(tracked);
    } else if (message.type === "popover-size") {
      this.popover.sized(message.box, message.issue, message.height);
    } else if (message.type === "popover-closed") {
      const target = this.popover.open?.target;
      if (this.popover.closedByFrame(message.box) && target !== undefined) {
        this.restoreFocus(target.state.element);
      }
    } else if (message.type === "all-issues") {
      const tracked = this.byId.get(message.box);
      if (tracked === undefined) return;
      const shown = this.popover.isOpenFor(tracked) ? this.popover.open?.issue : undefined;
      this.openDialog(tracked, shown ?? null);
    } else if (message.type === "dialog-ready") {
      this.dialog.drawn(message.box);
    } else if (message.type === "dialog-select") {
      this.dialog.selected(message.box, message.issue);
    } else if (message.type === "dialog-closed") {
      const target = this.dialog.open?.target;
      if (this.dialog.closedByFrame(message.box) && target !== undefined) {
        this.restoreFocus(target.state.element);
      }
    } else if (message.type === "resync") {
      const tracked = this.byId.get(message.box);
      if (tracked === undefined) return;
      this.syncBox(tracked.state);
      this.link.post({
        type: "text",
        box: tracked.state.id,
        revision: tracked.state.revision,
        text: tracked.state.text,
      });
    }
  }

  // The badge

  private onBadge(state: BoxState): void {
    if (this.blocked !== undefined) {
      const tracked = this.byId.get(state.id);
      if (tracked === undefined) return;
      // Only Open in English Tutor is offered: nothing else can work without the frame.
      this.syncBox(state);
      const rect = tracked.badge.element.getBoundingClientRect();
      this.card.open(this.blocked.message, { left: rect.left, top: rect.top }, () => {
        this.deps.runtime.openInTutor(state.text).catch((err: unknown) => {
          this.deps.log.error("could not open the tutor page", { err });
        });
      });
      return;
    }
    // The issues dialog (SPEC section 4.11): the badge opens it, and closes it again.
    const tracked = this.byId.get(state.id);
    if (tracked === undefined) return;
    if (this.dialog.isOpenFor(tracked)) this.closeDialog(false);
    else this.openDialog(tracked, null);
  }

  private render(tracked: Tracked): void {
    tracked.badge.show(badgeViewOf(tracked.state, this.blocked?.message));
    this.place(tracked);
    // The issues moved or went: the card follows its issue, or closes with it.
    if (this.popover.isOpenFor(tracked)) this.popover.place();
  }

  // Following the boxes

  private schedulePosition(): void {
    if (this.frame !== undefined || this.boxes.size === 0) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = undefined;
      this.position();
    });
  }

  /** Puts every badge at the bottom right inside its box. */
  position(): void {
    for (const tracked of [...this.boxes.values()]) this.place(tracked);
    this.popover.place();
    this.dialog.place();
  }

  /** Draws the underlines of a box; the issue the popover or the dialog selects has the 20% background. */
  private drawUnderlines(tracked: PopoverTarget, visible = true): void {
    tracked.underlines.draw(
      this.popover.selectedIn(tracked) ?? this.dialog.selectedIn(tracked),
      visible,
    );
  }

  /**
   * Puts the badge at the bottom right inside its box, and shows it on the focused box and on a box
   * that still has issues. A box that left the page loses its state and its badge.
   */
  private place(tracked: Tracked): void {
    const { state, badge } = tracked;
    if (!state.element.isConnected) {
      this.forget(tracked);
      return;
    }
    const spot = badgeSpot(state.element, this.win);
    badge.place(spot.left, spot.top);
    // A box scrolled out of the window has no badge to show.
    badge.setVisible(spot.inView && (state.focused || state.issues.length > 0));
    this.drawUnderlines(tracked, spot.inView);
  }

  destroy(): void {
    this.layout.stop();
    for (const remove of this.listeners.splice(0)) remove();
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.card.close();
    for (const tracked of this.boxes.values()) {
      tracked.underlines.remove();
      tracked.badge.remove();
    }
    this.boxes.clear();
    this.byId.clear();
    this.link.close();
    this.host.remove();
  }
}
