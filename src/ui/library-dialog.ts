import { countWords } from "../core/analysis";
import { AppError } from "../core/errors";
import type { LibraryDocument } from "../core/store";
import { formatDate } from "../core/view";
import { Banner } from "./banner";
import { el, setHidden, setText } from "./dom";
import { closeModal, onDismiss, showModal } from "./modal";

/** What the Library dialog reads and does. The tutor page implements it over the store. */
export interface LibraryActions {
  /** The documents, newest update first. */
  list(): Promise<LibraryDocument[]>;
  /**
   * Opens the document in the tab (after the unsaved-changes question). Resolves true when it was
   * opened, which closes the dialog, and false when the user cancelled.
   */
  open(document: LibraryDocument): Promise<boolean>;
  /** Asks for a new title and renames. */
  rename(document: LibraryDocument): Promise<void>;
  /** Deletes the document (the dialog asked the user first). */
  remove(document: LibraryDocument): Promise<void>;
  /** Called with every failure, for the log. The dialog shows its message in its own banner. */
  onError?(err: unknown): void;
}

/**
 * The Library dialog (SPEC section 8): the saved texts by last update, each with **Open**,
 * **Rename** and **Delete**. Delete asks first, inside the dialog. A failure shows its message in a
 * banner inside the dialog, and the list stays as it was.
 */
export class LibraryDialog {
  private readonly doc: Document;
  private readonly actions: LibraryActions;
  private readonly dialog: HTMLDialogElement;
  private readonly banner: Banner;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly confirm: HTMLElement;
  private readonly confirmText: HTMLElement;
  private readonly confirmDelete: HTMLButtonElement;
  private documents: LibraryDocument[] = [];
  private toDelete: LibraryDocument | undefined;
  /** Counts the loads; an answer for an older one is ignored. */
  private loadRun = 0;
  private busy = false;

  constructor(doc: Document, host: HTMLElement, actions: LibraryActions) {
    this.doc = doc;
    this.actions = actions;
    const bannerHost = el(doc, "div", { id: "library-banner-host" });
    this.banner = new Banner(doc, bannerHost, "library-banner");
    this.list = el(doc, "ul", { id: "library-list", class: "library-list" });
    this.empty = el(doc, "p", { id: "library-empty", class: "empty", hidden: true }, [
      "The library is empty. Use Save to library to keep a text here.",
    ]);
    this.confirmText = el(doc, "span", { class: "confirm-text" });
    this.confirmDelete = el(
      doc,
      "button",
      { type: "button", class: "danger", id: "library-delete-ok" },
      ["Delete"],
    );
    const cancelDelete = el(doc, "button", { type: "button", id: "library-delete-cancel" }, [
      "Cancel",
    ]);
    this.confirm = el(
      doc,
      "div",
      { id: "library-confirm", class: "confirm-bar", role: "alert", hidden: true },
      [this.confirmText, this.confirmDelete, cancelDelete],
    );
    const closeButton = el(doc, "button", { type: "button", id: "library-close" }, ["Close"]);
    this.dialog = el(
      doc,
      "dialog",
      { id: "library-dialog", class: "modal library-dialog", "aria-labelledby": "library-title" },
      [
        el(doc, "div", { class: "library-head" }, [
          el(doc, "h2", { id: "library-title" }, ["Library"]),
          closeButton,
        ]),
        bannerHost,
        this.confirm,
        el(doc, "div", { class: "library-body" }, [this.list, this.empty]),
      ],
    );
    host.append(this.dialog);

    closeButton.addEventListener("click", () => {
      this.close();
    });
    onDismiss(this.dialog, () => {
      this.close();
    });
    cancelDelete.addEventListener("click", () => {
      this.askToDelete(undefined);
    });
    this.confirmDelete.addEventListener("click", () => {
      const document = this.toDelete;
      this.askToDelete(undefined);
      if (document !== undefined) this.run(() => this.actions.remove(document));
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opens the dialog and reads the library. */
  async open(): Promise<void> {
    if (!this.dialog.open) {
      this.banner.hide();
      this.askToDelete(undefined);
      showModal(this.dialog);
    }
    await this.reload();
  }

  close(): void {
    this.loadRun++;
    this.askToDelete(undefined);
    closeModal(this.dialog);
  }

  destroy(): void {
    this.close();
    this.dialog.remove();
  }

  /**
   * Reads the library again (the dialog opened, or another tab announced `library-changed`). A
   * failure is shown in the banner and the list keeps what it had.
   */
  async reload(): Promise<void> {
    const run = ++this.loadRun;
    try {
      const documents = await this.actions.list();
      if (run !== this.loadRun || !this.dialog.open) return;
      this.documents = documents;
      this.banner.hide();
      this.render();
    } catch (err) {
      if (run !== this.loadRun) return;
      this.fail(err);
    }
  }

  private render(): void {
    this.list.replaceChildren(...this.documents.map((document) => this.row(document)));
    setHidden(this.empty, this.documents.length > 0);
    if (this.toDelete !== undefined && !this.documents.some((d) => d.id === this.toDelete?.id)) {
      this.askToDelete(undefined);
    }
  }

  private row(document: LibraryDocument): HTMLElement {
    const open = el(this.doc, "button", { type: "button", class: "library-open" }, ["Open"]);
    const rename = el(this.doc, "button", { type: "button", class: "library-rename" }, ["Rename"]);
    const remove = el(this.doc, "button", { type: "button", class: "library-delete" }, ["Delete"]);
    open.addEventListener("click", () => {
      this.run(async () => {
        if (await this.actions.open(document)) this.close();
      });
    });
    rename.addEventListener("click", () => {
      this.run(() => this.actions.rename(document));
    });
    remove.addEventListener("click", () => {
      this.askToDelete(document);
    });
    const words = countWords(document.content);
    return el(this.doc, "li", { class: "library-row", "data-id": String(document.id) }, [
      el(this.doc, "div", { class: "library-info" }, [
        el(this.doc, "span", { class: "library-title" }, [document.title]),
        el(this.doc, "span", { class: "library-meta" }, [
          `${formatDate(document.updated_at)} · ${String(words)} ${words === 1 ? "word" : "words"}`,
        ]),
      ]),
      el(this.doc, "div", { class: "library-actions" }, [open, rename, remove]),
    ]);
  }

  private askToDelete(document: LibraryDocument | undefined): void {
    this.toDelete = document;
    if (document !== undefined) {
      setText(
        this.confirmText,
        `Delete “${document.title}” from the library? This cannot be undone.`,
      );
    }
    setHidden(this.confirm, document === undefined);
    if (document !== undefined) this.confirmDelete.focus();
  }

  /** Runs an action; the list is read again either way, and a failure goes to the banner. */
  private run(action: () => Promise<void>): void {
    if (this.busy) return;
    this.busy = true;
    const done = async (): Promise<void> => {
      let failure: { err: unknown } | undefined;
      try {
        await action();
      } catch (err) {
        failure = { err };
      }
      this.busy = false;
      if (this.dialog.open) await this.reload();
      if (failure !== undefined) this.fail(failure.err);
    };
    done().catch((err: unknown) => {
      this.busy = false;
      this.fail(err);
    });
  }

  private fail(err: unknown): void {
    this.actions.onError?.(err);
    this.banner.show(err instanceof AppError ? err.message : "Something went wrong.");
  }
}
