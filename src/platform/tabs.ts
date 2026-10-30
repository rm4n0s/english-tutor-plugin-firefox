/** Opens extension pages in browser tabs. The only place that calls `browser.tabs`. */
export interface TabOpener {
  /** Opens `path` (for example `"tutor.html"`) of this extension in a new tab. */
  open(path: string): Promise<void>;
}

export class BrowserTabOpener implements TabOpener {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async open(path: string): Promise<void> {
    await this.api.tabs.create({ url: this.api.runtime.getURL(path) });
  }
}

/** The tab this page is shown in. The only place that calls `browser.tabs.getCurrent`. */
export interface CurrentTab {
  /** The tab's id, or undefined where the page is not in a tab. Needs no permission. */
  id(): Promise<number | undefined>;
}

export class BrowserCurrentTab implements CurrentTab {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async id(): Promise<number | undefined> {
    const tab: browser.tabs.Tab | undefined = await this.api.tabs.getCurrent();
    return tab?.id;
  }
}
