import { AppError } from "../core/errors";

/** An entry of the context menu a page overrides (a row of the issues list, the editor). */
export interface MenuEntry {
  /** Unique among the extension's entries. A page makes its ids from its tab id. */
  id: string;
  title: string;
  /** Default true. An entry that is not visible does not show in the menu. */
  visible?: boolean;
  /** Default true. */
  enabled?: boolean;
}

export interface MenuChanges {
  title?: string;
  visible?: boolean;
  enabled?: boolean;
}

/** An entry was chosen. `tabId` is the tab the menu was shown for. */
export interface MenuClick {
  id: string;
  tabId: number | undefined;
}

/** A menu is about to show; `ids` are the extension's entries in it. */
export interface MenuShown {
  ids: readonly string[];
  tabId: number | undefined;
}

/**
 * The extension's context menus (`browser.menus`), for pages that show their own menu: the page
 * calls `overrideContext` in a `contextmenu` handler, which makes the browser leave out its own
 * entries and show only the extension's (SPEC sections 4.3 and 4.4). The only place that calls
 * `browser.menus`. It needs the `menus` and `menus.overrideContext` permissions.
 *
 * The browser sends `onClicked`, `onShown` and `onHidden` to every open page of the extension,
 * so each page must check that the event is for its own tab and its own entries.
 */
export interface ContextMenus {
  /**
   * Makes the entries, for every context, on pages whose address matches one of
   * `documentUrlPatterns` (so only on the extension's own page). Fails with `ContextMenuFailed`.
   */
  create(entries: readonly MenuEntry[], documentUrlPatterns: readonly string[]): Promise<void>;
  /** Removes entries. Entries that do not exist are skipped. Fails with `ContextMenuFailed`. */
  remove(ids: readonly string[]): Promise<void>;
  /** Fails with `ContextMenuFailed`. */
  update(id: string, changes: MenuChanges): Promise<void>;
  /** Redraws the menu that is open, after `update` calls made in an `onShown` listener. */
  refresh(): Promise<void>;
  /**
   * Makes this `contextmenu` event open the extension's menu. With `showDefaults` false the
   * browser's own entries are left out and only the extension's visible entries show (the issues
   * list); with true they stay and the extension's follow them (the editor). Call it
   * synchronously from the event handler.
   */
  overrideContext(options: { showDefaults: boolean }): void;
  /** Returns the function that removes the listener. */
  onClicked(listener: (click: MenuClick) => void): () => void;
  onShown(listener: (shown: MenuShown) => void): () => void;
  onHidden(listener: () => void): () => void;
}

/**
 * `runtime.lastError` is a plain object with a message, not an `Error`, so the message is taken
 * from it; other foreign errors are wrapped as they are.
 */
function failure(err: unknown, where: string): AppError {
  const message =
    typeof err === "object" && err !== null && "message" in err && typeof err.message === "string"
      ? err.message
      : "unknown error";
  return new AppError("ContextMenuFailed", message, {}, { cause: err }).via(where);
}

export class BrowserContextMenus implements ContextMenus {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  create(entries: readonly MenuEntry[], documentUrlPatterns: readonly string[]): Promise<void> {
    return Promise.all(entries.map((entry) => this.createOne(entry, documentUrlPatterns))).then(
      () => undefined,
    );
  }

  // `menus.create` reports a problem through `runtime.lastError` in its callback.
  private createOne(entry: MenuEntry, documentUrlPatterns: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.api.menus.create(
          {
            id: entry.id,
            title: entry.title,
            contexts: ["all"],
            documentUrlPatterns: [...documentUrlPatterns],
            visible: entry.visible ?? true,
            enabled: entry.enabled ?? true,
          },
          () => {
            // Firefox sets `lastError` to null, not undefined, when there is no problem.
            const problem: unknown = this.api.runtime.lastError;
            if (problem === undefined || problem === null) resolve();
            else
              reject(AppError.wrap("ContextMenuFailed", problem).via("BrowserContextMenus.create"));
          },
        );
      } catch (err) {
        reject(failure(err, "BrowserContextMenus.create"));
      }
    });
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.api.menus.remove(id);
      } catch {
        // Already gone: the page is closing, or the entry was never made.
      }
    }
  }

  async update(id: string, changes: MenuChanges): Promise<void> {
    try {
      await this.api.menus.update(id, { ...changes });
    } catch (err) {
      throw failure(err, "BrowserContextMenus.update");
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.api.menus.refresh();
    } catch (err) {
      throw failure(err, "BrowserContextMenus.refresh");
    }
  }

  overrideContext(options: { showDefaults: boolean }): void {
    this.api.menus.overrideContext({ showDefaults: options.showDefaults });
  }

  onClicked(listener: (click: MenuClick) => void): () => void {
    const handler = (info: browser.menus.OnClickData, tab?: browser.tabs.Tab): void => {
      listener({ id: String(info.menuItemId), tabId: tab?.id });
    };
    this.api.menus.onClicked.addListener(handler);
    return () => {
      this.api.menus.onClicked.removeListener(handler);
    };
  }

  onShown(listener: (shown: MenuShown) => void): () => void {
    const handler = (info: { menuIds: (number | string)[] }, tab?: browser.tabs.Tab): void => {
      listener({ ids: info.menuIds.map(String), tabId: tab?.id });
    };
    this.api.menus.onShown.addListener(handler);
    return () => {
      this.api.menus.onShown.removeListener(handler);
    };
  }

  onHidden(listener: () => void): () => void {
    this.api.menus.onHidden.addListener(listener);
    return () => {
      this.api.menus.onHidden.removeListener(listener);
    };
  }
}
