import { el, setText } from "./dom";

/**
 * The in-page confirmation before a link of an explanation opens (SPEC section 4.5). It shows the
 * full address, so that the user sees where the link goes, and resolves `ask` with true on **Open
 * link** and false on **Cancel**, `Escape` or a click outside the box. Only one is open at a time:
 * asking again cancels the one before.
 */
export class LinkConfirm {
  private readonly doc: Document;
  private readonly backdrop: HTMLElement;
  private readonly address: HTMLElement;
  private readonly openButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private settle: ((open: boolean) => void) | undefined;
  private returnFocus: Element | null = null;

  constructor(doc: Document, host: HTMLElement) {
    this.doc = doc;
    this.address = el(doc, "code", { class: "link-confirm-url", id: "link-confirm-url" });
    this.openButton = el(
      doc,
      "button",
      { type: "button", class: "primary", id: "link-confirm-open" },
      ["Open link"],
    );
    this.cancelButton = el(doc, "button", { type: "button", id: "link-confirm-cancel" }, [
      "Cancel",
    ]);
    const box = el(
      doc,
      "div",
      {
        class: "link-confirm-box",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": "link-confirm-title",
        "aria-describedby": "link-confirm-url",
      },
      [
        el(doc, "h2", { class: "link-confirm-title", id: "link-confirm-title" }, [
          "Open this link?",
        ]),
        el(doc, "p", { class: "link-confirm-text" }, [
          "The explanation links to this address. It opens in a new tab, and English Tutor does not control what is there.",
        ]),
        this.address,
        el(doc, "div", { class: "link-confirm-buttons" }, [this.openButton, this.cancelButton]),
      ],
    );
    this.backdrop = el(doc, "div", { class: "link-confirm", id: "link-confirm", hidden: true }, [
      box,
    ]);
    host.append(this.backdrop);

    this.openButton.addEventListener("click", () => {
      this.close(true);
    });
    this.cancelButton.addEventListener("click", () => {
      this.close(false);
    });
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close(false);
    });
    this.backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close(false);
      } else if (event.key === "Tab") {
        // Keep the focus inside the box while it is open.
        const buttons = [this.openButton, this.cancelButton];
        const index = buttons.findIndex((b) => b === this.doc.activeElement);
        const next = event.shiftKey ? index - 1 : index + 1;
        event.preventDefault();
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }
    });
  }

  /** Whether the box is open. */
  get visible(): boolean {
    return !this.backdrop.hidden;
  }

  /** Shows `url` and resolves with the user's choice. */
  ask(url: string): Promise<boolean> {
    this.close(false);
    this.returnFocus = this.doc.activeElement;
    setText(this.address, url);
    this.backdrop.hidden = false;
    this.openButton.focus();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Closes the box if it is open, as if the user cancelled (it stays in the page). */
  dismiss(): void {
    this.close(false);
  }

  /** Closes the box as if the user cancelled. */
  destroy(): void {
    this.close(false);
    this.backdrop.remove();
  }

  private close(open: boolean): void {
    const settle = this.settle;
    this.settle = undefined;
    if (this.backdrop.hidden) return;
    this.backdrop.hidden = true;
    const focus = this.returnFocus;
    this.returnFocus = null;
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    settle?.(open);
  }
}
