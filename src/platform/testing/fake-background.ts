import type { Commands } from "../commands";
import type { Lifecycle } from "../lifecycle";
import type { Notifier } from "../notifications";
import type { OptionsOpener } from "../options-page";
import type { ToolbarButton } from "../toolbar-button";
import type { TabPlace, TutorPingResponder, TutorTabInfo, TutorTabs } from "../tutor-tabs";
import type { BackgroundMenus, WebMenuClick, WebMenuItem } from "../web-menus";

export class FakeButton implements ToolbarButton {
  private handler: (() => void) | undefined;

  onClick(handler: () => void): void {
    this.handler = handler;
  }

  /** The user clicks the toolbar button. */
  click(): void {
    this.handler?.();
  }
}

export class FakeCommands implements Commands {
  private handler: ((name: string) => void) | undefined;

  onCommand(handler: (name: string) => void): void {
    this.handler = handler;
  }

  /** The user presses a shortcut. */
  press(name: string): void {
    this.handler?.(name);
  }
}

export class FakeLifecycle implements Lifecycle {
  reloads = 0;
  private installed: (() => void) | undefined;
  private started: (() => void) | undefined;
  private updated: (() => void) | undefined;

  onInstalled(handler: () => void): void {
    this.installed = handler;
  }

  onStartup(handler: () => void): void {
    this.started = handler;
  }

  onUpdateAvailable(handler: () => void): void {
    this.updated = handler;
  }

  reload(): void {
    this.reloads++;
  }

  install(): void {
    this.installed?.();
  }

  startBrowser(): void {
    this.started?.();
  }

  updateAvailable(): void {
    this.updated?.();
  }
}

export class FakeOptionsOpener implements OptionsOpener {
  opened = 0;

  open(): Promise<void> {
    this.opened++;
    return Promise.resolve();
  }
}

/** Notifications in memory. `click` stands for the user. */
export class FakeNotifier implements Notifier {
  /** The notifications that are showing, by id. */
  readonly shown = new Map<string, { title: string; message: string }>();
  readonly cleared: string[] = [];
  failWith: Error | undefined;
  private handler: ((id: string) => void) | undefined;

  show(id: string, title: string, message: string): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.shown.set(id, { title, message });
    return Promise.resolve();
  }

  clear(id: string): Promise<void> {
    this.cleared.push(id);
    this.shown.delete(id);
    return Promise.resolve();
  }

  onClicked(handler: (id: string) => void): void {
    this.handler = handler;
  }

  click(id: string): void {
    this.handler?.(id);
  }
}

/** The tutor tabs as the background script sees them: what they answer, what was done to them. */
export class FakeTutorTabs implements TutorTabs {
  /** What the open tutor pages answer to a ping. */
  pages: TutorTabInfo[] = [];
  pingFails: Error | undefined;
  pings = 0;
  readonly focused: { tabId: number; windowId: number }[] = [];
  readonly opened: { fragment?: string; after?: TabPlace }[] = [];

  ping(): Promise<TutorTabInfo[]> {
    this.pings++;
    if (this.pingFails !== undefined) return Promise.reject(this.pingFails);
    return Promise.resolve(this.pages.map((page) => ({ ...page })));
  }

  focus(tab: { tabId: number; windowId: number }): Promise<void> {
    this.focused.push({ tabId: tab.tabId, windowId: tab.windowId });
    return Promise.resolve();
  }

  open(options: { fragment?: string; after?: TabPlace } = {}): Promise<void> {
    this.opened.push(options);
    return Promise.resolve();
  }
}

/** The extension's tutor pages answer the ping of the fake tabs through this, for page tests. */
export class FakePingResponder implements TutorPingResponder {
  private answer: (() => Promise<TutorTabInfo | undefined>) | undefined;

  onPing(answer: () => Promise<TutorTabInfo | undefined>): () => void {
    this.answer = answer;
    return () => {
      this.answer = undefined;
    };
  }

  /** The background script pings the page. */
  ping(): Promise<TutorTabInfo | undefined> {
    return this.answer === undefined ? Promise.resolve(undefined) : this.answer();
  }

  get listening(): boolean {
    return this.answer !== undefined;
  }
}

/** The background script's menus in memory, with the user's actions. */
export class FakeBackgroundMenus implements BackgroundMenus {
  /** The entries made by `install`, by id. */
  readonly entries = new Map<string, WebMenuItem>();
  installs = 0;
  failWith: Error | undefined;
  private clicked: ((click: WebMenuClick) => void) | undefined;

  install(items: readonly WebMenuItem[]): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.installs++;
    for (const item of items) this.entries.set(item.id, item);
    return Promise.resolve();
  }

  onClicked(listener: (click: WebMenuClick) => void): void {
    this.clicked = listener;
  }

  /** The user chooses an entry. */
  choose(id: string, click: Partial<Omit<WebMenuClick, "id">> = {}): void {
    this.clicked?.({ id, selectionText: undefined, tab: undefined, ...click });
  }
}
