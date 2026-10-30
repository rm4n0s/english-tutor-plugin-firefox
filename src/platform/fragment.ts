/** The address fragment of the page (`#handoff=<key>`, SPEC section 4.1). */
export interface PageFragment {
  /** The fragment with its `#`, or "" when there is none. */
  get(): string;
  /** Removes it from the address without reloading and without a new history entry. */
  clear(): void;
}

export class WindowFragment implements PageFragment {
  private readonly win: Pick<Window, "location" | "history">;

  constructor(win: Pick<Window, "location" | "history">) {
    this.win = win;
  }

  get(): string {
    return this.win.location.hash;
  }

  clear(): void {
    const { location, history } = this.win;
    history.replaceState(history.state, "", location.pathname + location.search);
  }
}
