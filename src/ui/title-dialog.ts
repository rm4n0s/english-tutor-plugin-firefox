import { cleanTitle, MAX_TITLE_LENGTH } from "../core/files";
import { el, setHidden, setText } from "./dom";
import { closeModal, onDismiss, showModal } from "./modal";

export interface TitlePrompt {
  /** The dialog's heading, for example "Save to library". */
  heading: string;
  /** The title in the field when the dialog opens. */
  initial: string;
  /** The label of the confirm button, for example "Save". */
  confirm: string;
}

/**
 * The in-page dialog that asks for a title (SPEC section 8): Save to library, and Rename in the
 * Library dialog. `ask` resolves with the title the user confirmed (trimmed, at most 200
 * characters) or undefined when the user cancelled (`Cancel`, `Escape`, a click outside). An empty
 * title is not accepted: the dialog says so and stays open.
 */
export class TitleDialog {
  private readonly doc: Document;
  private readonly dialog: HTMLDialogElement;
  private readonly heading: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly problem: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private settle: ((title: string | undefined) => void) | undefined;
  private returnFocus: Element | null = null;

  constructor(doc: Document, host: HTMLElement) {
    this.doc = doc;
    this.heading = el(doc, "h2", { class: "modal-title", id: "title-heading" });
    this.input = el(doc, "input", {
      type: "text",
      id: "title-input",
      maxlength: String(MAX_TITLE_LENGTH),
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": "title-problem",
    });
    this.problem = el(doc, "p", {
      id: "title-problem",
      class: "modal-problem",
      role: "alert",
      hidden: true,
    });
    this.confirmButton = el(doc, "button", { type: "submit", class: "primary", id: "title-ok" });
    const cancel = el(doc, "button", { type: "button", id: "title-cancel" }, ["Cancel"]);
    const form = el(doc, "form", { class: "modal-box", id: "title-form" }, [
      this.heading,
      el(doc, "label", { class: "modal-field", for: "title-input" }, ["Title", this.input]),
      this.problem,
      el(doc, "div", { class: "modal-buttons" }, [this.confirmButton, cancel]),
    ]);
    this.dialog = el(
      doc,
      "dialog",
      { id: "title-dialog", class: "modal", "aria-labelledby": "title-heading" },
      [form],
    );
    host.append(this.dialog);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = cleanTitle(this.input.value);
      if (title === undefined) {
        setText(this.problem, "Enter a title.");
        setHidden(this.problem, false);
        this.input.focus();
        return;
      }
      this.close(title);
    });
    this.input.addEventListener("input", () => {
      setHidden(this.problem, true);
    });
    cancel.addEventListener("click", () => {
      this.close(undefined);
    });
    onDismiss(this.dialog, () => {
      this.close(undefined);
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  ask(prompt: TitlePrompt): Promise<string | undefined> {
    this.close(undefined);
    this.returnFocus = this.doc.activeElement;
    setText(this.heading, prompt.heading);
    setText(this.confirmButton, prompt.confirm);
    this.input.value = prompt.initial;
    setHidden(this.problem, true);
    showModal(this.dialog);
    this.input.focus();
    this.input.select();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Closes the dialog as if the user cancelled. */
  destroy(): void {
    this.close(undefined);
    this.dialog.remove();
  }

  private close(title: string | undefined): void {
    const settle = this.settle;
    this.settle = undefined;
    if (!this.dialog.open) {
      settle?.(title);
      return;
    }
    closeModal(this.dialog);
    const focus = this.returnFocus;
    this.returnFocus = null;
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    settle?.(title);
  }
}
