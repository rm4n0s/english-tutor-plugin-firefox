/** The tab's own `sessionStorage` (SPEC section 4.2): the text and its state survive a reload. */
export interface TabStorage {
  /** The stored value, or null. */
  read(): string | null;
  /** Throws when the browser refuses (the quota). */
  write(value: string): void;
}

const KEY = "english-tutor-tab";

/** `sessionStorage`, which belongs to one tab: a new tab starts empty, a reload keeps it. */
export class SessionTabStorage implements TabStorage {
  private readonly storage: Pick<Storage, "getItem" | "setItem">;

  constructor(storage: Pick<Storage, "getItem" | "setItem">) {
    this.storage = storage;
  }

  read(): string | null {
    try {
      return this.storage.getItem(KEY);
    } catch {
      // A browser that blocks storage: the tab starts empty.
      return null;
    }
  }

  write(value: string): void {
    this.storage.setItem(KEY, value);
  }
}
