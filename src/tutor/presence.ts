import type { Clock } from "../core/clock";
import type { CurrentTab } from "../platform/tabs";
import type { TutorPingResponder, TutorTabInfo } from "../platform/tutor-tabs";

export interface TutorPresenceDeps {
  responder: TutorPingResponder;
  currentTab: CurrentTab;
  clock: Clock;
  /** Whether the tab's text has unsaved changes. */
  isDirty(): boolean;
}

/**
 * Lets the background script find this tab (SPEC section 4.1): it records when the tab was last
 * focused and answers the `tutor-ping` message with `{ tabId, windowId, focusedAt, dirty }`.
 * A tab counts as focused from the moment it is visible when it opens, when its window gets the
 * focus and when it becomes the visible tab again.
 */
export class TutorPresence {
  private readonly doc: Document;
  private readonly deps: TutorPresenceDeps;
  private focusedAt = 0;
  private readonly stops: (() => void)[] = [];

  constructor(doc: Document, deps: TutorPresenceDeps) {
    this.doc = doc;
    this.deps = deps;
  }

  start(): void {
    const { doc } = this;
    const win = doc.defaultView;
    const mark = (): void => {
      if (doc.visibilityState === "visible") this.focusedAt = this.deps.clock.now();
    };
    mark();
    doc.addEventListener("visibilitychange", mark);
    win?.addEventListener("focus", mark);
    this.stops.push(
      () => {
        doc.removeEventListener("visibilitychange", mark);
        win?.removeEventListener("focus", mark);
      },
      this.deps.responder.onPing(() => this.answer()),
    );
  }

  /** The time the tab was last focused, or 0. */
  get lastFocusedAt(): number {
    return this.focusedAt;
  }

  destroy(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  private async answer(): Promise<TutorTabInfo | undefined> {
    const tab = await this.deps.currentTab.info();
    if (tab === undefined) return undefined;
    return {
      tabId: tab.tabId,
      windowId: tab.windowId,
      focusedAt: this.focusedAt,
      dirty: this.deps.isDirty(),
    };
  }
}
