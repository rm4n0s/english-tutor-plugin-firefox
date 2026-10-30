import type { IgnoreSet } from "../core/store";
import type { SessionStorage } from "./session-storage";

const PREFIX = "ignore:";

/**
 * The Not-an-error ignore set (SPEC section 5.7) in `storage.session`, so that every tutor tab
 * (and page mode) shares it until the browser closes. Each (source, fingerprint) pair is a key of
 * its own, so two tabs adding pairs at the same moment cannot overwrite each other.
 */
export class SessionIgnoreSet implements IgnoreSet {
  private readonly storage: SessionStorage;

  constructor(storage: SessionStorage) {
    this.storage = storage;
  }

  async has(source: string, fingerprint: string): Promise<boolean> {
    const key = ignoreKey(source, fingerprint);
    return key in (await this.storage.get([key]));
  }

  add(source: string, fingerprint: string): Promise<void> {
    return this.storage.set({ [ignoreKey(source, fingerprint)]: true });
  }
}

/** The `storage.session` key of a pair. A fingerprint is hex, so `|` cannot be inside it. */
export function ignoreKey(source: string, fingerprint: string): string {
  return `${PREFIX}${source}|${fingerprint}`;
}
