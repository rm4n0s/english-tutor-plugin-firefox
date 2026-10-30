import { el, setText } from "./dom";
import { closeModal, onDismiss, showModal } from "./modal";

export type UnsavedChoice = "save" | "discard" | "cancel";

/** What the unsaved-changes dialog says about the text. */
export interface UnsavedPrompt {
  /** The text's name, if it has one. */
  name: string | undefined;
  /** True when Save updates a library document; false when it downloads a file. */
  library: boolean;
}

/**
 * The in-page dialog before New, Clear, Open and opening a library document replace a text with
 * unsaved changes (SPEC section 8): **Save**, **Discard** and **Cancel**. `ask` resolves with the
 * choice; `Escape` and a click outside count as Cancel. Only one is open at a time: asking again
 * cancels the one before.
 */
export class UnsavedDialog {
  private readonly doc: Document;
  private readonly dialog: HTMLDialogElement;
  private readonly message: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private settle: ((choice: UnsavedChoice) => void) | undefined;
  private returnFocus: Element | null = null;

  constructor(doc: Document, host: HTMLElement) {
    this.doc = doc;
    this.message = el(doc, "p", { id: "unsaved-message", class: "modal-text" });
    this.hint = el(doc, "p", { id: "unsaved-hint", class: "modal-hint" });
    this.saveButton = el(doc, "button", { type: "button", class: "primary", id: "unsaved-save" }, [
      "Save",
    ]);
    const discard = el(doc, "button", { type: "button", id: "unsaved-discard" }, ["Discard"]);
    const cancel = el(doc, "button", { type: "button", id: "unsaved-cancel" }, ["Cancel"]);
    this.dialog = el(
      doc,
      "dialog",
      {
        id: "unsaved-dialog",
        class: "modal",
        role: "alertdialog",
        "aria-labelledby": "unsaved-title",
        "aria-describedby": "unsaved-message",
      },
      [
        el(doc, "div", { class: "modal-box" }, [
          el(doc, "h2", { class: "modal-title", id: "unsaved-title" }, ["Unsaved changes"]),
          this.message,
          this.hint,
          el(doc, "div", { class: "modal-buttons" }, [this.saveButton, discard, cancel]),
        ]),
      ],
    );
    host.append(this.dialog);

    this.saveButton.addEventListener("click", () => {
      this.close("save");
    });
    discard.addEventListener("click", () => {
      this.close("discard");
    });
    cancel.addEventListener("click", () => {
      this.close("cancel");
    });
    onDismiss(this.dialog, () => {
      this.close("cancel");
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  ask(prompt: UnsavedPrompt): Promise<UnsavedChoice> {
    this.close("cancel");
    this.returnFocus = this.doc.activeElement;
    setText(
      this.message,
      prompt.name === undefined
        ? "This text has changes that are not saved."
        : `“${prompt.name}” has changes that are not saved.`,
    );
    setText(
      this.hint,
      prompt.library
        ? "Save updates the document in the library."
        : "Save downloads the text as a file.",
    );
    showModal(this.dialog);
    this.saveButton.focus();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Closes the dialog as if the user cancelled. */
  destroy(): void {
    this.close("cancel");
    this.dialog.remove();
  }

  private close(choice: UnsavedChoice): void {
    const settle = this.settle;
    this.settle = undefined;
    if (!this.dialog.open) {
      settle?.(choice);
      return;
    }
    closeModal(this.dialog);
    const focus = this.returnFocus;
    this.returnFocus = null;
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    settle?.(choice);
  }
}
