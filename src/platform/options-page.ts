/** Opens the extension's options page. The only place that calls `browser.runtime.openOptionsPage`. */
export interface OptionsOpener {
  open(): Promise<void>;
}

export class BrowserOptionsOpener implements OptionsOpener {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  open(): Promise<void> {
    return this.api.runtime.openOptionsPage();
  }
}
