import type { ContextMenus, MenuChanges, MenuClick, MenuEntry, MenuShown } from "../menus";
import type { CurrentTab } from "../tabs";

/** A tab id, for tests of pages that learn theirs from `tabs.getCurrent()`. */
export class FakeCurrentTab implements CurrentTab {
  tabId: number | undefined;

  constructor(tabId?: number) {
    this.tabId = tabId;
  }

  id(): Promise<number | undefined> {
    return Promise.resolve(this.tabId);
  }
}

export interface FakeEntry {
  title: string;
  visible: boolean;
  enabled: boolean;
  patterns: readonly string[];
}

/**
 * The context menus in memory. Like the browser, it tells every listener of every page about a
 * click, a shown menu and a hidden menu. `choose`, `show` and `hide` stand for the user.
 */
export class FakeContextMenus implements ContextMenus {
  readonly entries = new Map<string, FakeEntry>();
  /** How many times `overrideContext` was called. */
  overridden = 0;
  /** The `showDefaults` of the last `overrideContext` call. */
  lastShowDefaults: boolean | undefined;
  /** How many times `refresh` was called. */
  refreshes = 0;
  failWith: Error | undefined;
  private readonly clicked = new Set<(click: MenuClick) => void>();
  private readonly shown = new Set<(shown: MenuShown) => void>();
  private readonly hidden = new Set<() => void>();

  create(entries: readonly MenuEntry[], documentUrlPatterns: readonly string[]): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    for (const entry of entries) {
      if (this.entries.has(entry.id)) {
        return Promise.reject(new Error(`ID already exists: ${entry.id}`));
      }
    }
    for (const entry of entries) {
      this.entries.set(entry.id, {
        title: entry.title,
        visible: entry.visible ?? true,
        enabled: entry.enabled ?? true,
        patterns: [...documentUrlPatterns],
      });
    }
    return Promise.resolve();
  }

  remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.entries.delete(id);
    return Promise.resolve();
  }

  update(id: string, changes: MenuChanges): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    const entry = this.entries.get(id);
    if (entry === undefined) return Promise.reject(new Error(`No menu item with id ${id}`));
    this.entries.set(id, {
      ...entry,
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.visible === undefined ? {} : { visible: changes.visible }),
      ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
    });
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    this.refreshes++;
    return Promise.resolve();
  }

  overrideContext(options: { showDefaults: boolean }): void {
    this.overridden++;
    this.lastShowDefaults = options.showDefaults;
  }

  onClicked(listener: (click: MenuClick) => void): () => void {
    this.clicked.add(listener);
    return () => {
      this.clicked.delete(listener);
    };
  }

  onShown(listener: (shown: MenuShown) => void): () => void {
    this.shown.add(listener);
    return () => {
      this.shown.delete(listener);
    };
  }

  onHidden(listener: () => void): () => void {
    this.hidden.add(listener);
    return () => {
      this.hidden.delete(listener);
    };
  }

  // The user.

  /** The user opens the menu of `tabId`: the listeners hear which entries are visible. */
  show(tabId: number): void {
    const ids = [...this.entries].filter(([, entry]) => entry.visible).map(([id]) => id);
    for (const listener of [...this.shown]) listener({ ids, tabId });
  }

  hide(): void {
    for (const listener of [...this.hidden]) listener();
  }

  /** The user chooses an entry of the menu that was opened for `tabId`. */
  choose(id: string, tabId: number): void {
    for (const listener of [...this.clicked]) listener({ id, tabId });
  }

  /** The ids of the entries that would show now. */
  get visibleIds(): string[] {
    return [...this.entries].filter(([, entry]) => entry.visible).map(([id]) => id);
  }
}
