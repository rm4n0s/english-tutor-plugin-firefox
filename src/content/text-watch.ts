/**
 * Notices changes of the text of editable content that no `input` event reports (SPEC section
 * 4.11, "Checking"): a page that clears or replaces the children or the text nodes of an editor
 * from its own script (React, Quill, Draft.js, ProseMirror, Lexical, after a message is sent).
 * One `MutationObserver` per tracked editing host, watching only that host (`characterData`,
 * `childList`, `subtree`), never the whole page; it is disconnected when the box is forgotten.
 *
 * The text of `<textarea>` and `<input>` boxes cannot be watched this way (a script that sets
 * `value` fires nothing): `PageModeContent` re-reads them on events and on the layout watcher's
 * timer instead.
 */
export class EditableWatcher {
  private readonly win: Window;
  private readonly onChange: (element: HTMLElement) => void;
  private readonly observers = new Map<HTMLElement, MutationObserver>();

  /** `onChange` is called once per batch of mutations of a watched host, after they happened. */
  constructor(win: Window, onChange: (element: HTMLElement) => void) {
    this.win = win;
    this.onChange = onChange;
  }

  /** How many hosts are watched. */
  get size(): number {
    return this.observers.size;
  }

  has(element: HTMLElement): boolean {
    return this.observers.has(element);
  }

  watch(element: HTMLElement): void {
    if (this.observers.has(element)) return;
    const Observer = (this.win as Window & typeof globalThis).MutationObserver as
      typeof MutationObserver | undefined;
    if (typeof Observer !== "function") return;
    const observer = new Observer(() => {
      this.onChange(element);
    });
    observer.observe(element, { characterData: true, childList: true, subtree: true });
    this.observers.set(element, observer);
  }

  /**
   * The caller has just read the host (an `input` event): the mutations that led to that text are
   * not news. Mutations that happen later, even in the same turn, are still reported.
   */
  acknowledge(element: HTMLElement): void {
    this.observers.get(element)?.takeRecords();
  }

  unwatch(element: HTMLElement): void {
    this.observers.get(element)?.disconnect();
    this.observers.delete(element);
  }

  stop(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }
}
