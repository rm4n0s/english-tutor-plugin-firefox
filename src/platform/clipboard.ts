import { AppError } from "../core/errors";

/** Puts text on the system clipboard (the Alternatives panel's Copy, SPEC section 4.6). */
export interface Clipboard {
  /** Fails with `ClipboardWriteFailed`. Call it from a click or key handler (a user gesture). */
  writeText(text: string): Promise<void>;
}

/**
 * `navigator.clipboard.writeText`, which an extension page may call from a user gesture without
 * the `clipboardWrite` permission. The text is never logged or put in the error.
 */
export class BrowserClipboard implements Clipboard {
  private readonly nav: Pick<Navigator, "clipboard">;

  constructor(nav: Pick<Navigator, "clipboard">) {
    this.nav = nav;
  }

  async writeText(text: string): Promise<void> {
    try {
      await this.nav.clipboard.writeText(text);
    } catch (err) {
      throw AppError.wrap("ClipboardWriteFailed", err).via("BrowserClipboard.writeText");
    }
  }
}
