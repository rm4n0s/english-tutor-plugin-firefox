/** The tab this page is shown in. The only place that calls `browser.tabs.getCurrent`. */
export interface CurrentTab {
  /** The tab's id, or undefined where the page is not in a tab. Needs no permission. */
  id(): Promise<number | undefined>;
  /** The tab's id and window id, or undefined where the page is not in a tab. */
  info(): Promise<{ tabId: number; windowId: number } | undefined>;
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

  async info(): Promise<{ tabId: number; windowId: number } | undefined> {
    const tab: browser.tabs.Tab | undefined = await this.api.tabs.getCurrent();
    return tab?.id === undefined || tab.windowId === undefined
      ? undefined
      : { tabId: tab.id, windowId: tab.windowId };
  }
}
