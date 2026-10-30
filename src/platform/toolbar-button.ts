/** The toolbar button. The only place that calls `browser.action`. */
export interface ToolbarButton {
  onClick(handler: () => void): void;
}

export class BrowserToolbarButton implements ToolbarButton {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  onClick(handler: () => void): void {
    this.api.action.onClicked.addListener(() => {
      handler();
    });
  }
}
