import type { Scheduler } from "../core/clock";
import type { AppError } from "../core/errors";
import type { Logger } from "../core/log";
import type { PageBroadcast } from "../core/page-mode/messages";
import { PAGE_MODE_OFF } from "../core/page-mode/messages";
import type { FrameMessage } from "../core/page-mode/protocol";
import type { Random } from "../core/random";
import type { PageModeRuntime } from "../platform/page-mode";
import type { PageConnector } from "../platform/page-port";
import { Badge, BADGE_SIZE } from "./badge";
import { badgeViewOf } from "./badge-view";
import { BlockedCard } from "./blocked-card";
import { BoxState } from "./box-state";
import { FrameLink } from "./frame-link";
import { OverlayHost } from "./overlay-host";
import { findTextBox } from "./text-box";

export interface PageModeContentDeps {
  /** The page's window. */
  win: Window & typeof globalThis;
  runtime: PageModeRuntime;
  connector: PageConnector;
  scheduler: Scheduler;
  random: Random;
  log: Logger;
  /** `open` lets a test look inside the shadow root; the extension always uses `closed`. */
  overlayMode?: "closed" | "open";
  frameTimeoutMs?: number;
}

/** A text box the badge was clicked on: the seam where step 15 opens the issues dialog. */
export interface BadgeClick {
  box: BoxState;
}

/** Space between the badge and the box's inner corner. */
const BADGE_MARGIN = 4;

interface Tracked {
  state: BoxState;
  badge: Badge;
}

/**
 * Page mode on one web page, in one frame of it (SPEC section 4.11). It asks the background script
 * whether page mode runs on this host, then watches focus: a text box takes part only after the
 * user focuses it (events the page dispatches itself, `isTrusted === false`, are ignored). It keeps
 * the box's text state, sends the text and each edit to the frame over the port, and draws the
 * badge from what the frame answers. Everything it adds to the page is in one element with a
 * closed shadow root. It never calls an LLM and never sees a key or a setting.
 *
 * `page-mode-off` removes everything; `settings-changed` asks the background script again.
 */
export class PageModeContent {
  private readonly deps: PageModeContentDeps;
  private readonly win: Window & typeof globalThis;
  private readonly doc: Document;
  private active: Active | undefined;
  private stopListening: (() => void) | undefined;
  private asks = 0;
  /** Called when a badge is clicked and the frame is working: step 15 opens the dialog here. */
  onBadgeClick: (click: BadgeClick) => void = () => undefined;

  constructor(deps: PageModeContentDeps) {
    this.deps = deps;
    this.win = deps.win;
    this.doc = deps.win.document;
  }

  /** Whether page mode is showing anything on this page now. */
  get running(): boolean {
    return this.active !== undefined;
  }

  /** The text boxes the user has focused, with their state (for tests and for step 14). */
  get boxes(): readonly BoxState[] {
    return this.active === undefined ? [] : [...this.active.boxes.values()].map((t) => t.state);
  }

  /** Puts every badge where its box is now (a test, or a layout change the observers missed). */
  reposition(): void {
    this.active?.position();
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
    let enabled = false;
    try {
      enabled = await this.deps.runtime.enabledOn(this.win.location.hostname);
    } catch (err) {
      this.deps.log.error("page mode could not ask whether it runs here", { err });
    }
    if (ask !== this.asks) return;
    if (enabled) this.attach();
    else this.detach();
  }

  private attach(): void {
    if (this.active !== undefined) return;
    this.active = new Active(this.deps, this.win, this.doc, (click) => {
      this.onBadgeClick(click);
    });
  }

  private detach(): void {
    this.active?.destroy();
    this.active = undefined;
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
  private readonly onBadgeClick: (click: BadgeClick) => void;
  private readonly listeners: (() => void)[] = [];
  private focused: Tracked | undefined;
  private nextId = 1;
  private frame: number | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private mutationObserver: MutationObserver | undefined;

  constructor(
    deps: PageModeContentDeps,
    win: Window & typeof globalThis,
    doc: Document,
    onBadgeClick: (click: BadgeClick) => void,
  ) {
    this.deps = deps;
    this.win = win;
    this.doc = doc;
    this.onBadgeClick = onBadgeClick;
    this.host = new OverlayHost(doc, deps.overlayMode ?? "closed");
    this.card = new BlockedCard(doc, this.host.layer);
    this.link = new FrameLink(
      {
        doc,
        parent: this.host.layer,
        connector: deps.connector,
        frameUrl: (id) => deps.runtime.frameUrl(id),
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
          for (const tracked of this.boxes.values()) this.render(tracked);
        },
      },
    );
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
    // Following a box: scrolling anywhere, resizing, and layout changes.
    on(this.win, "scroll", () => {
      this.schedulePosition();
    });
    on(this.win, "resize", () => {
      this.schedulePosition();
    });
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
    if (this.host.owns(event.target)) return;
    const found = findTextBox(event.composedPath()[0] ?? event.target, this.win);
    if (found === undefined) {
      this.deactivate();
      return;
    }
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
      const badge = new Badge(this.doc, this.host.layer, () => {
        this.onBadge(state);
      });
      badge.setVisible(false);
      tracked = { state, badge };
      this.boxes.set(found.element, tracked);
      this.byId.set(state.id, tracked);
      this.observe();
      this.resizeObserver?.observe(found.element);
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
    this.syncBox(tracked.state);
    this.render(tracked);
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
    this.link.post({ type: "forget", box: tracked.state.id });
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
    // The dialog of step 15 opens here.
    this.onBadgeClick({ box: state });
  }

  private render(tracked: Tracked): void {
    tracked.badge.show(badgeViewOf(tracked.state, this.blocked?.message));
    this.place(tracked);
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
    const rect = state.element.getBoundingClientRect();
    const style = this.win.getComputedStyle(state.element);
    const px = (value: string): number => Number.parseFloat(value) || 0;
    const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
    const borderY = px(style.borderTopWidth) + px(style.borderBottomWidth);
    // The room of a scroll bar is not part of the text area either.
    const scrollbarX = Math.max(0, state.element.offsetWidth - state.element.clientWidth - borderX);
    const scrollbarY = Math.max(
      0,
      state.element.offsetHeight - state.element.clientHeight - borderY,
    );
    badge.place(
      rect.right - px(style.borderRightWidth) - scrollbarX - BADGE_SIZE - BADGE_MARGIN,
      rect.bottom - px(style.borderBottomWidth) - scrollbarY - BADGE_SIZE - BADGE_MARGIN,
    );
    // A box scrolled out of the window has no badge to show.
    const inView =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < this.win.innerHeight &&
      rect.left < this.win.innerWidth;
    badge.setVisible(inView && (state.focused || state.issues.length > 0));
  }

  destroy(): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.card.close();
    for (const tracked of this.boxes.values()) tracked.badge.remove();
    this.boxes.clear();
    this.byId.clear();
    this.link.close();
    this.host.remove();
  }
}
