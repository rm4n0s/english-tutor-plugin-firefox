import { AppError } from "../core/errors";

/** Opens an address from an explanation in a new tab. The only place that calls `browser.tabs` for it. */
export interface LinkOpener {
  /**
   * Opens `url` (an `http` or `https` address the user confirmed) in a new tab next to this one.
   * Fails with `LinkOpenFailed`.
   */
  open(url: string): Promise<void>;
}

export class BrowserLinkOpener implements LinkOpener {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  /**
   * The new tab goes right after the tutor tab. `tabs.create` and `tabs.getCurrent` need no
   * permission. Where there is no current tab (a page-mode frame is not a tab) the browser decides
   * the position.
   */
  async open(url: string): Promise<void> {
    try {
      const current: browser.tabs.Tab | undefined = await this.api.tabs.getCurrent();
      await this.api.tabs.create(
        current === undefined ? { url } : { url, index: current.index + 1 },
      );
    } catch (err) {
      throw AppError.wrap("LinkOpenFailed", err).via("BrowserLinkOpener.open");
    }
  }
}
