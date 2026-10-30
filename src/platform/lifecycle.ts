/** Installation, start-up and updates of the extension. The only place that calls `browser.runtime` for them. */
export interface Lifecycle {
  /**
   * The extension was installed, updated or loaded as a temporary add-on. `reason` is the
   * browser's: `install` for a first installation (a temporary add-on too), `update`, ...
   */
  onInstalled(handler: (reason: string) => void): void;
  /** The browser started with the extension installed. */
  onStartup(handler: () => void): void;
  /** A new version was downloaded and waits for the extension to restart (SPEC section 7). */
  onUpdateAvailable(handler: () => void): void;
  /** Restarts the extension now, which installs the waiting update and closes its tabs. */
  reload(): void;
}

export class BrowserLifecycle implements Lifecycle {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  onInstalled(handler: (reason: string) => void): void {
    this.api.runtime.onInstalled.addListener((details) => {
      handler(details.reason);
    });
  }

  onStartup(handler: () => void): void {
    this.api.runtime.onStartup.addListener(() => {
      handler();
    });
  }

  onUpdateAvailable(handler: () => void): void {
    this.api.runtime.onUpdateAvailable.addListener(() => {
      handler();
    });
  }

  reload(): void {
    this.api.runtime.reload();
  }
}
