/**
 * Opens the extension's options page. The only place that calls `browser.runtime.openOptionsPage`
 * and opens the welcome page.
 */
export interface OptionsOpener {
  open(): Promise<void>;
  /** Opens `options.html#welcome` in a new tab: what the first installation shows (SPEC section 4.11). */
  openWelcome(): Promise<void>;
}

export class BrowserOptionsOpener implements OptionsOpener {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  open(): Promise<void> {
    return this.api.runtime.openOptionsPage();
  }

  async openWelcome(): Promise<void> {
    await this.api.tabs.create({ url: this.api.runtime.getURL("options.html#welcome") });
  }
}
