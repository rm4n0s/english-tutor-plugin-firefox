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
