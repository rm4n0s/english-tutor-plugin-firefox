/**
 * `storage.session` (SPEC section 9): small values shared by all pages of the extension until the
 * browser closes. The only place that calls `browser.storage.session`. Hand-off entries (step 12)
 * and the Not-an-error ignore set use it.
 */
export interface SessionStorage {
  /** The stored values of these keys; a key without a value is missing from the result. */
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  /** Everything stored (hand-off entries and the ignore set share the storage). */
  getAll(): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

export class BrowserSessionStorage implements SessionStorage {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  get(keys: readonly string[]): Promise<Record<string, unknown>> {
    return this.api.storage.session.get([...keys]);
  }

  getAll(): Promise<Record<string, unknown>> {
    return this.api.storage.session.get(null);
  }

  set(items: Readonly<Record<string, unknown>>): Promise<void> {
    return this.api.storage.session.set({ ...items });
  }

  remove(keys: readonly string[]): Promise<void> {
    return this.api.storage.session.remove([...keys]);
  }
}
