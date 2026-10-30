/**
 * Desktop notifications (SPEC section 4.10). The only place that calls `browser.notifications`.
 * The tutor page shows one; the background script hears the click.
 */
export interface Notifier {
  /** Shows a notification, replacing the one with the same id. */
  show(id: string, title: string, message: string): Promise<void>;
  clear(id: string): Promise<void>;
  /** Registers the listener. Call it synchronously at the top level of the background script. */
  onClicked(handler: (id: string) => void): void;
}

export class BrowserNotifier implements Notifier {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async show(id: string, title: string, message: string): Promise<void> {
    await this.api.notifications.create(id, {
      type: "basic",
      title,
      message,
      iconUrl: this.api.runtime.getURL("icons/icon-96.png"),
    });
  }

  async clear(id: string): Promise<void> {
    await this.api.notifications.clear(id);
  }

  onClicked(handler: (id: string) => void): void {
    this.api.notifications.onClicked.addListener((id) => {
      handler(id);
    });
  }
}
