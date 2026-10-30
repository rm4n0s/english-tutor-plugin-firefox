import { parseSavedTab, serialiseSavedTab, type SavedTab } from "../core/files";
import type { Scheduler } from "../core/clock";
import type { Logger } from "../core/log";
import type { TabStorage } from "../platform/tab-storage";

/** How long after a change the tab's state is written. */
export const PERSIST_DELAY_MS = 400;

export interface TabPersistenceDeps {
  storage: TabStorage;
  scheduler: Scheduler;
  log: Logger;
  /** The tab's text and state as they are now. */
  snapshot(): SavedTab;
}

/**
 * Keeps the tab's text, source key, name, library document, line ending and dirty flag in the
 * tab's `sessionStorage` (SPEC section 4.2), so that reloading the tab, or restoring a closed one,
 * gives the text back. Issues are not kept. A change is written after a short pause (a long text
 * is not written on every key); `flush` writes at once, for when the page is hidden or unloaded.
 * A write the browser refuses (quota) is logged and the tab goes on.
 */
export class TabPersistence {
  private readonly deps: TabPersistenceDeps;
  private cancel: (() => void) | undefined;

  constructor(deps: TabPersistenceDeps) {
    this.deps = deps;
  }

  /** What was stored by an earlier page of this tab, if it is valid. */
  restore(): SavedTab | undefined {
    return parseSavedTab(this.deps.storage.read());
  }

  /** Something changed: write soon. */
  schedule(): void {
    if (this.cancel !== undefined) return;
    this.cancel = this.deps.scheduler.after(PERSIST_DELAY_MS, () => {
      this.cancel = undefined;
      this.write();
    });
  }

  /** Writes now if a write is waiting. */
  flush(): void {
    if (this.cancel === undefined) return;
    this.cancel();
    this.cancel = undefined;
    this.write();
  }

  destroy(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  private write(): void {
    try {
      this.deps.storage.write(serialiseSavedTab(this.deps.snapshot()));
    } catch (err) {
      this.deps.log.warn("could not keep the tab's text for a reload", { err });
    }
  }
}
