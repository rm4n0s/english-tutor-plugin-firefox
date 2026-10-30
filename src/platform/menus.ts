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
 * calls `overrideContext` in a `contextmenu` handler, which makes the browser show only the
 * entries made for the `tab` context (SPEC sections 4.3 and 4.4). The only place that calls
 * `browser.menus`.
 *
 * The browser sends `onClicked`, `onShown` and `onHidden` to every open page of the extension,
 * so each page must check that the event is for its own tab and its own entries.
 */
export interface ContextMenus {
  /**
   * Makes the entries, for the `tab` context, on pages whose address matches one of
   * `documentUrlPatterns`. Fails with `ContextMenuFailed`.
   */
  create(entries: readonly MenuEntry[], documentUrlPatterns: readonly string[]): Promise<void>;
  /** Removes entries. Entries that do not exist are skipped. Fails with `ContextMenuFailed`. */
  remove(ids: readonly string[]): Promise<void>;
  /** Fails with `ContextMenuFailed`. */
  update(id: string, changes: MenuChanges): Promise<void>;
  /** Redraws the menu that is open, after `update` calls made in an `onShown` listener. */
  refresh(): Promise<void>;
  /**
   * Replaces the menu that this `contextmenu` event opens with the `tab` context menu of the tab.
   * Call it synchronously from the event handler.
   */
  overrideContext(tabId: number): void;
  /** Returns the function that removes the listener. */
  onClicked(listener: (click: MenuClick) => void): () => void;
  onShown(listener: (shown: MenuShown) => void): () => void;
  onHidden(listener: () => void): () => void;
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
            contexts: ["tab"],
            documentUrlPatterns: [...documentUrlPatterns],
            visible: entry.visible ?? true,
            enabled: entry.enabled ?? true,
          },
          () => {
            const problem = this.api.runtime.lastError;
            if (problem === undefined) resolve();
            else
              reject(AppError.wrap("ContextMenuFailed", problem).via("BrowserContextMenus.create"));
          },
        );
      } catch (err) {
        reject(AppError.wrap("ContextMenuFailed", err).via("BrowserContextMenus.create"));
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
      throw AppError.wrap("ContextMenuFailed", err).via("BrowserContextMenus.update");
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.api.menus.refresh();
    } catch (err) {
      throw AppError.wrap("ContextMenuFailed", err).via("BrowserContextMenus.refresh");
    }
  }

  overrideContext(tabId: number): void {
    this.api.menus.overrideContext({ context: "tab", tabId });
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
