import { AppError } from "../core/errors";
import {
  defaultTitle,
  downloadFileName,
  NEW_TEXT,
  nameFromFileName,
  nameFromPath,
  readTextFile,
  type DecodedText,
  withLineEnding,
  type FileLike,
  type TabText,
  type TextInfo,
} from "../core/files";
import type { Logger } from "../core/log";
import {
  docSource,
  type DocumentInput,
  type LibraryDocument,
  type MoveResult,
  type TabSource,
} from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { Clipboard } from "../platform/clipboard";
import type { DownloadResult, Downloads } from "../platform/downloads";
import type { TitlePrompt } from "../ui/title-dialog";
import type { UnsavedChoice, UnsavedPrompt } from "../ui/unsaved-dialog";

/** The documents of the library, as the flow uses them. `Store` fits. */
export interface LibraryStore {
  getDocument(id: number): Promise<LibraryDocument>;
  createDocument(input: DocumentInput): Promise<LibraryDocument>;
  updateDocument(id: number, input: DocumentInput): Promise<LibraryDocument>;
  renameDocument(id: number, title: string): Promise<LibraryDocument>;
  deleteDocument(id: number): Promise<void>;
}

/** The mistakes of a text move with it from a `session:` source to `doc:<id>`. `Stats` fits. */
export interface SourceMover {
  moveSource(from: string, to: string): Promise<MoveResult>;
}

/** The unsaved-changes dialog. `UnsavedDialog` fits. */
export interface UnsavedAsker {
  ask(prompt: UnsavedPrompt): Promise<UnsavedChoice>;
}

/** The title dialog. `TitleDialog` fits. */
export interface TitleAsker {
  ask(prompt: TitlePrompt): Promise<string | undefined>;
}

/** What the flow needs from the page. */
export interface SavingHost {
  /** The editor's text, with `\n` line breaks. */
  getText(): string;
  /**
   * Puts a text in the editor as a loaded text, which is not an edit: the issues go, a running
   * check or explanation is cancelled, and no auto-check starts (SPEC section 5.5).
   */
  loadText(text: string): void;
  /** Shows a failure (the banner). */
  report(err: unknown): void;
  /** Hides the banner; it belongs to the text that was replaced. */
  clearBanner(): void;
  /** Says something short in the status bar, for example "Copied". */
  flash(message: string): void;
  /** The mistakes of the source changed: read the badges again. */
  statsMoved(): void;
}

export interface SavingDeps {
  host: SavingHost;
  tabText: TabText;
  source: TabSource;
  store: LibraryStore;
  stats: SourceMover;
  channel: ChangeChannel;
  downloads: Downloads;
  clipboard: Clipboard;
  unsaved: UnsavedAsker;
  titles: TitleAsker;
  log: Logger;
}

/** A chosen file: `File` fits. */
export interface ChosenFile extends FileLike {
  readonly name: string;
}

/**
 * New, Clear, Copy, Open, Save, Save As, Save to library and the Library's actions (SPEC section
 * 8), with no DOM: the page gives it the editor through `SavingHost` and the dialogs through the
 * two askers. One operation runs at a time; a click while another one waits (for a dialog, or for
 * the download) is ignored.
 *
 * Every operation that replaces the text first asks about unsaved changes, after the new text has
 * been read successfully. A failure is reported to the page and never throws.
 */
export class SavingFlow {
  private readonly deps: SavingDeps;
  private busy = false;

  constructor(deps: SavingDeps) {
    this.deps = deps;
  }

  /** True while an operation waits for a dialog or a file. */
  get isBusy(): boolean {
    return this.busy;
  }

  // New, Clear and Copy

  /** New and Clear: an empty text with a new `session:` source, after the unsaved-changes question. */
  newText(): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(await this.confirmDiscard())) return false;
      this.load("", NEW_TEXT, () => this.deps.source.renew());
      return true;
    });
  }

  /** Copy: the whole text on the clipboard. Call it in the click handler (a user gesture). */
  async copy(): Promise<void> {
    const text = this.deps.host.getText();
    if (text === "") return;
    try {
      await this.deps.clipboard.writeText(text);
      this.deps.host.flash("Copied");
    } catch (err) {
      this.fail(err, "SavingFlow.copy");
    }
  }

  // Files

  /**
   * Open: reads the chosen file first, and only when that worked asks about unsaved changes and
   * replaces the text. A file that is too big, not UTF-8 or unreadable leaves the text alone.
   */
  openFile(file: ChosenFile): Promise<boolean> {
    return this.exclusive(async () => {
      let decoded: DecodedText;
      try {
        decoded = await readTextFile(file);
      } catch (err) {
        this.fail(err, "SavingFlow.openFile");
        return false;
      }
      if (!(await this.confirmDiscard())) return false;
      this.load(
        decoded.text,
        {
          name: nameFromFileName(file.name),
          documentId: undefined,
          lineEnding: decoded.lineEnding,
        },
        () => this.deps.source.renew(),
      );
      return true;
    });
  }

  /** Save: downloads the text under its name. A text without a name behaves like Save As. */
  save(): Promise<boolean> {
    return this.exclusive(() => this.doSave());
  }

  /** Save As: downloads the text and lets the user choose the name in the browser's dialog. */
  saveAs(): Promise<boolean> {
    return this.exclusive(() => this.doSaveAs());
  }

  private doSave(): Promise<boolean> {
    const { tabText, host } = this.deps;
    if (tabText.name === undefined) return this.doSaveAs();
    return this.download(host.getText(), downloadFileName(tabText.name), false);
  }

  private doSaveAs(): Promise<boolean> {
    const { tabText, host } = this.deps;
    const text = host.getText();
    return this.download(text, downloadFileName(tabText.name ?? defaultTitle(text)), true);
  }

  private async download(text: string, filename: string, saveAs: boolean): Promise<boolean> {
    const { downloads, tabText, host } = this.deps;
    let result: DownloadResult;
    try {
      result = await downloads.download({
        text: withLineEnding(text, tabText.lineEnding),
        filename,
        saveAs,
      });
    } catch (err) {
      this.fail(err, "SavingFlow.download");
      return false;
    }
    if (result.kind === "cancelled") return false;
    // The name the user typed becomes the text's name. A library document keeps its title: the
    // title is what the next Save to library would write.
    if (saveAs && tabText.documentId === undefined) {
      const name = nameFromPath(result.path);
      if (name !== undefined) tabText.rename(name);
    }
    // Typing while the download ran leaves the newer text unsaved.
    if (host.getText() === text) tabText.saved();
    return true;
  }

  // Library

  /**
   * Save to library. A new text asks for a title (default: its name, or its first line cut to 60
   * characters), stores a document, moves the source from `session:<uuid>` to `doc:<id>` and tells
   * the other tabs. A text that came from the library updates its document without asking.
   */
  saveToLibrary(): Promise<boolean> {
    return this.exclusive(() => this.doSaveToLibrary());
  }

  private async doSaveToLibrary(): Promise<boolean> {
    const { host, tabText, store, source, stats, channel } = this.deps;
    const text = host.getText();
    const content = (title: string): DocumentInput => ({
      title,
      content: text,
      line_ending: tabText.lineEnding,
    });
    const openId = tabText.documentId;
    let document: LibraryDocument;
    try {
      if (openId !== undefined) {
        document = await store.updateDocument(openId, content(tabText.name ?? defaultTitle(text)));
      } else {
        const title = await this.deps.titles.ask({
          heading: "Save to library",
          initial: tabText.name ?? defaultTitle(text),
          confirm: "Save",
        });
        if (title === undefined) return false;
        document = await store.createDocument(content(title));
      }
    } catch (err) {
      // The document was deleted meanwhile: the text keeps its name and is no longer attached.
      if (err instanceof AppError && err.tag === "DocumentNotFound") tabText.detach();
      this.fail(err, "SavingFlow.saveToLibrary");
      return false;
    }
    if (openId === undefined) {
      const from = source.moveToDocument(document.id);
      tabText.attach(document.id, document.title);
      try {
        await stats.moveSource(from, docSource(document.id));
      } catch (err) {
        // The document is stored; only the earlier mistakes stay under the old source.
        this.fail(err, "SavingFlow.saveToLibrary");
      }
      channel.post("stats-changed");
      host.statsMoved();
    }
    channel.post("library-changed");
    if (host.getText() === text) tabText.saved();
    return true;
  }

  /**
   * Opens a library document in the tab: reads it again, then asks about unsaved changes.
   * Resolves false when the user cancelled or the document could not be read.
   */
  openDocument(id: number): Promise<boolean> {
    return this.exclusive(async () => {
      let document: LibraryDocument;
      try {
        document = await this.deps.store.getDocument(id);
      } catch (err) {
        this.fail(err, "SavingFlow.openDocument");
        return false;
      }
      if (!(await this.confirmDiscard())) return false;
      this.load(
        document.content,
        { name: document.title, documentId: document.id, lineEnding: document.line_ending },
        () => this.deps.source.useDocument(document.id),
      );
      return true;
    });
  }

  /** Renames a document after asking for the new title; the open document renames the tab. */
  async renameDocument(document: LibraryDocument): Promise<void> {
    const title = await this.deps.titles.ask({
      heading: "Rename",
      initial: document.title,
      confirm: "Rename",
    });
    if (title === undefined || title === document.title) return;
    try {
      await this.deps.store.renameDocument(document.id, title);
    } catch (err) {
      throw this.wrapped(err, "SavingFlow.renameDocument");
    }
    this.deps.channel.post("library-changed");
    if (this.deps.tabText.documentId === document.id) this.deps.tabText.rename(title);
  }

  /** Deletes a document (the Library dialog asked first). The open document is detached. */
  async deleteDocument(document: LibraryDocument): Promise<void> {
    try {
      await this.deps.store.deleteDocument(document.id);
    } catch (err) {
      throw this.wrapped(err, "SavingFlow.deleteDocument");
    }
    this.deps.channel.post("library-changed");
    if (this.deps.tabText.documentId === document.id) this.deps.tabText.detach();
  }

  /**
   * The library changed (this tab restored a library text, or another tab announced
   * `library-changed`): the open document's title is read again, and a document that is gone
   * detaches the text. The text itself is never replaced: the last save wins.
   */
  async syncWithLibrary(): Promise<void> {
    const { tabText, store, log } = this.deps;
    const id = tabText.documentId;
    if (id === undefined) return;
    try {
      const document = await store.getDocument(id);
      if (tabText.documentId === id && tabText.name !== document.title) {
        tabText.rename(document.title);
      }
    } catch (err) {
      if (err instanceof AppError && err.tag === "DocumentNotFound") {
        if (tabText.documentId === id) tabText.detach();
      } else {
        log.warn("could not read the open library document", { err });
      }
    }
  }

  // Unsaved changes

  /**
   * Before a text is replaced (SPEC section 8): true when it may be. With unsaved changes the user
   * chooses Save (a library text is saved to the library, any other text is downloaded),
   * Discard or Cancel. A failed or cancelled save cancels the action too.
   */
  private async confirmDiscard(): Promise<boolean> {
    const { tabText } = this.deps;
    if (!tabText.unsaved) return true;
    const library = tabText.documentId !== undefined;
    const choice = await this.deps.unsaved.ask({ name: tabText.name, library });
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    return library ? this.doSaveToLibrary() : this.doSave();
  }

  // Helpers

  private load(text: string, info: TextInfo, newSource: () => string): void {
    newSource();
    this.deps.host.loadText(text);
    this.deps.tabText.loaded(info, text);
    this.deps.host.clearBanner();
  }

  private async exclusive(work: () => Promise<boolean>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  private wrapped(err: unknown, where: string): unknown {
    return err instanceof AppError ? err.via(where) : err;
  }

  private fail(err: unknown, where: string): void {
    this.deps.host.report(err instanceof AppError ? err.via(where) : err);
  }
}
