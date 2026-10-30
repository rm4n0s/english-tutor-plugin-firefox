import { AppError } from "../core/errors";

/** An entry of the menus the background script makes: the web page menu and the button's menu. */
export interface WebMenuItem {
  /** Unique among the extension's entries. */
  id: string;
  title: string;
  /** `selection`: the menu of a web page with selected text. `action`: the toolbar button's menu. */
  contexts: readonly ("selection" | "action")[];
  /** Makes this entry part of a submenu. The parent is listed before it. */
  parentId?: string;
  /**
   * Limits the entry to pages whose address matches one of these patterns (not the extension's
   * own pages, which have their own menus).
   */
  documentUrlPatterns?: readonly string[];
  /** False makes the entry (made hidden) show only after an `update` in `onShown`. */
  visible?: boolean;
}

/** A menu of the extension is about to show (`menus.onShown`). */
export interface WebMenuShown {
  /** The contexts the menu is shown for, for example `action`. */
  contexts: readonly string[];
  /** The address of the tab the menu belongs to; Firefox shows it only with a host permission. */
  tabUrl: string | undefined;
}

/** An entry was chosen. */
export interface WebMenuClick {
  id: string;
  /** The text selected on the page (Firefox can shorten a very long one), or undefined. */
  selectionText: string | undefined;
  /** The tab the menu was used in, where there is one. */
  tab: { tabId: number; windowId: number; index: number; url?: string | undefined } | undefined;
}

/**
 * The background script's menus (SPEC section 4.1). The only place that calls `browser.menus` for
 * them. The tutor page's own entries (`ContextMenus`) share the browser's `menus` events, so a
 * listener ignores ids that are not its own.
 */
export interface BackgroundMenus {
  /**
   * Makes the entries, replacing any with the same ids from an earlier run (the browser keeps
   * the entries of an extension between runs of its event page). Entries the tutor pages made are
   * left alone. Fails with `ContextMenuFailed`.
   */
  install(items: readonly WebMenuItem[]): Promise<void>;
  /** Register the listener synchronously at the top level of the background script. */
  onClicked(listener: (click: WebMenuClick) => void): void;
  /** Register the listener synchronously at the top level: a menu is about to show. */
  onShown(listener: (shown: WebMenuShown) => void): void;
  /** Changes an entry; fails with `ContextMenuFailed`. */
  update(id: string, change: { title?: string; visible?: boolean }): Promise<void>;
  /** Draws the open menu again after `update` calls made in `onShown`. */
  refresh(): Promise<void>;
}

function failure(err: unknown, where: string): AppError {
  const message =
    typeof err === "object" && err !== null && "message" in err && typeof err.message === "string"
      ? err.message
      : "unknown error";
  return new AppError("ContextMenuFailed", message, {}, { cause: err }).via(where);
}

export class BrowserBackgroundMenus implements BackgroundMenus {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async install(items: readonly WebMenuItem[]): Promise<void> {
    // Children first: removing a parent removes its children, and a missing id is no problem.
    for (const item of [...items].reverse()) {
      try {
        await this.api.menus.remove(item.id);
      } catch {
        // Not made yet.
      }
    }
    for (const item of items) await this.createOne(item);
  }

  // `menus.create` reports a problem through `runtime.lastError` in its callback.
  private createOne(item: WebMenuItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.api.menus.create(
          {
            id: item.id,
            title: item.title,
            contexts: [...item.contexts],
            ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
            ...(item.documentUrlPatterns === undefined
              ? {}
              : { documentUrlPatterns: [...item.documentUrlPatterns] }),
            ...(item.visible === undefined ? {} : { visible: item.visible }),
          },
          () => {
            // Firefox sets `lastError` to null, not undefined, when there is no problem.
            const problem: unknown = this.api.runtime.lastError;
            if (problem === undefined || problem === null) resolve();
            else
              reject(
                AppError.wrap("ContextMenuFailed", problem).via("BrowserBackgroundMenus.install"),
              );
          },
        );
      } catch (err) {
        reject(failure(err, "BrowserBackgroundMenus.install"));
      }
    });
  }

  onClicked(listener: (click: WebMenuClick) => void): void {
    this.api.menus.onClicked.addListener((info, tab) => {
      const placed =
        tab?.id === undefined || tab.windowId === undefined
          ? undefined
          : { tabId: tab.id, windowId: tab.windowId, index: tab.index, url: tab.url };
      listener({
        id: String(info.menuItemId),
        selectionText: info.selectionText,
        tab: placed,
      });
    });
  }

  onShown(listener: (shown: WebMenuShown) => void): void {
    this.api.menus.onShown.addListener((info, tab) => {
      listener({ contexts: info.contexts, tabUrl: tab.url });
    });
  }

  async update(id: string, change: { title?: string; visible?: boolean }): Promise<void> {
    try {
      await this.api.menus.update(id, change);
    } catch (err) {
      throw failure(err, "BrowserBackgroundMenus.update");
    }
  }

  async refresh(): Promise<void> {
    try {
      await this.api.menus.refresh();
    } catch (err) {
      throw failure(err, "BrowserBackgroundMenus.refresh");
    }
  }
}
