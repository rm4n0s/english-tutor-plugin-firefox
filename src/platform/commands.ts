/** Keyboard commands of the manifest. The only place that calls `browser.commands`. */
export interface Commands {
  /** Registers the listener. Call it synchronously at the top level of the background script. */
  onCommand(handler: (name: string) => void): void;
}

export class BrowserCommands implements Commands {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  onCommand(handler: (name: string) => void): void {
    this.api.commands.onCommand.addListener((name) => {
      handler(name);
    });
  }
}
