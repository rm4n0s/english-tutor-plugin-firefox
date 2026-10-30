import { trimSpace } from "../analysis/text";
import type { LineEnding } from "../store";
import { UNTITLED } from "./names";

/** What a tutor tab knows about its text besides the text itself (SPEC section 4.2). */
export interface TextInfo {
  /** The text's name: a file's name or a library title. Undefined for a text without one. */
  name: string | undefined;
  /** The library document the text came from or was saved to; undefined when it is none. */
  documentId: number | undefined;
  lineEnding: LineEnding;
}

export const NEW_TEXT: TextInfo = { name: undefined, documentId: undefined, lineEnding: "lf" };

/** What is kept in the tab's `sessionStorage` (SPEC section 4.2). Issues are not kept. */
export interface SavedTab extends TextInfo {
  text: string;
  /** The source key (`session:<uuid>` or `doc:<id>`, SPEC section 5.7). */
  source: string;
  dirty: boolean;
  /**
   * The id of the tab that wrote this, so that a duplicated tab (which copies `sessionStorage`)
   * can tell the state is not its own (SPEC section 4.2). Undefined when it was not known.
   */
  tabId?: number | undefined;
}

/**
 * The tab title (SPEC section 4.2): the text's name and a `*` for unsaved changes, then
 * " – English Tutor". A text without a name shows "Untitled".
 */
export function tabTitle(name: string | undefined, unsaved: boolean): string {
  return `${name ?? UNTITLED}${unsaved ? "*" : ""} – English Tutor`;
}

type Listener = () => void;

/**
 * The name, library document, line ending and unsaved-changes flag of the tab's text, with no
 * DOM. The page tells it what happened (`edited`, `loaded`, `saved`, ...) and listens for changes
 * to update the tab title and the buttons.
 *
 * A text has unsaved changes after an edit, until it is loaded, saved to a file or saved to the
 * library. A text that is only white space has nothing worth saving, so it never counts
 * (`unsaved`).
 */
export class TabText {
  private info: TextInfo = NEW_TEXT;
  private isDirty = false;
  private hasText = false;
  private readonly listeners = new Set<Listener>();

  get name(): string | undefined {
    return this.info.name;
  }

  get documentId(): number | undefined {
    return this.info.documentId;
  }

  get lineEnding(): LineEnding {
    return this.info.lineEnding;
  }

  /** The dirty flag as it is kept in `sessionStorage`. */
  get dirty(): boolean {
    return this.isDirty;
  }

  /** Whether there are changes to ask about: dirty, and the text is not only white space. */
  get unsaved(): boolean {
    return this.isDirty && this.hasText;
  }

  get title(): string {
    return tabTitle(this.info.name, this.unsaved);
  }

  /** The text was edited (typing, pasting, a replacement from the Alternatives panel). */
  edited(text: string): void {
    this.hasText = trimSpace(text) !== "";
    this.isDirty = true;
    this.emit();
  }

  /** A text was loaded (New, Open, a library document, a restored tab): nothing is unsaved. */
  loaded(info: TextInfo, text: string, dirty = false): void {
    this.info = { ...info };
    this.hasText = trimSpace(text) !== "";
    this.isDirty = dirty;
    this.emit();
  }

  /** The text was written to a file or stored in the library: nothing is unsaved. */
  saved(): void {
    this.isDirty = false;
    this.emit();
  }

  /** The text got a new name (a rename in the library, or the name typed in Save As). */
  rename(name: string | undefined): void {
    this.info = { ...this.info, name };
    this.emit();
  }

  /** The text is the library document with this id, titled `title`. */
  attach(documentId: number, title: string): void {
    this.info = { ...this.info, documentId, name: title };
    this.emit();
  }

  /** The text is not a library document any more (it was deleted). Its name stays. */
  detach(): void {
    this.info = { ...this.info, documentId: undefined };
    this.emit();
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const SOURCE_KEY = /^(session:.+|doc:[1-9]\d*)$/;

/** The JSON that goes into `sessionStorage`. */
export function serialiseSavedTab(tab: SavedTab): string {
  return JSON.stringify({
    v: 1,
    text: tab.text,
    source: tab.source,
    name: tab.name ?? null,
    documentId: tab.documentId ?? null,
    lineEnding: tab.lineEnding,
    dirty: tab.dirty,
    tabId: tab.tabId ?? null,
  });
}

/**
 * Reads what `serialiseSavedTab` wrote. Anything that is not exactly that (nothing stored, a
 * broken value, a wrong type, an unknown source) gives undefined, and the tab starts empty.
 */
export function parseSavedTab(raw: string | null | undefined): SavedTab | undefined {
  if (raw === null || raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { v, text, source, name, documentId, lineEnding, dirty, tabId } = value as Record<
    string,
    unknown
  >;
  if (v !== 1 || typeof text !== "string" || typeof source !== "string") return undefined;
  if (!SOURCE_KEY.test(source) || typeof dirty !== "boolean") return undefined;
  if (name !== null && typeof name !== "string") return undefined;
  if (lineEnding !== "lf" && lineEnding !== "crlf") return undefined;
  if (documentId !== null && !(Number.isInteger(documentId) && (documentId as number) > 0)) {
    return undefined;
  }
  // A state from before the tab id was kept has none; anything else must be a tab id or null.
  if (
    tabId !== undefined &&
    tabId !== null &&
    !(Number.isSafeInteger(tabId) && (tabId as number) >= 0)
  ) {
    return undefined;
  }
  return {
    text,
    source,
    name: name === "" ? undefined : (name ?? undefined),
    documentId: documentId === null ? undefined : (documentId as number),
    lineEnding,
    dirty,
    tabId: typeof tabId === "number" ? tabId : undefined,
  };
}
