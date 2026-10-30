import type { Clock } from "../clock";
import { AppError } from "../errors";
import type { Random } from "../random";

/** What the web page menu asks the tutor page to do with the text (SPEC section 4.1). */
export type HandoffAction = "check" | "alternatives";

/** The text of a web page selection on its way to a new tutor tab, kept in `storage.session`. */
export interface HandoffEntry {
  text: string;
  action: HandoffAction;
  /** Milliseconds since the epoch when the entry was stored, for the expiry. */
  at: number;
}

/** The part of `storage.session` the hand-off uses (`SessionStorage` in `src/platform` fits). */
export interface HandoffStorage {
  getAll(): Promise<Record<string, unknown>>;
  get(keys: readonly string[]): Promise<Record<string, unknown>>;
  set(items: Readonly<Record<string, unknown>>): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
}

/** Entries older than this are deleted when the background script next runs (SPEC section 4.1). */
export const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

const STORAGE_PREFIX = "handoff:";
const FRAGMENT_PREFIX = "#handoff=";
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The address fragment that names an entry: `#handoff=<key>`. The text is never in it. */
export function handoffFragment(key: string): string {
  return `${FRAGMENT_PREFIX}${key}`;
}

/** The key in an address fragment, or undefined when the fragment is not a hand-off. */
export function parseHandoffFragment(fragment: string): string | undefined {
  if (!fragment.startsWith(FRAGMENT_PREFIX)) return undefined;
  const key = fragment.slice(FRAGMENT_PREFIX.length);
  return KEY_PATTERN.test(key) ? key : undefined;
}

function isEntry(value: unknown): value is HandoffEntry {
  if (typeof value !== "object" || value === null) return false;
  const { text, action, at } = value as Record<string, unknown>;
  return (
    typeof text === "string" &&
    (action === "check" || action === "alternatives") &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

/**
 * Hand-off entries in `storage.session` (SPEC section 4.1). The background script puts one in
 * under a random key when a web page menu entry is chosen; the tutor page takes it out (reads and
 * deletes it) when it opens. It keeps no state of its own, so it works across the background
 * script's restarts.
 */
export class HandoffStore {
  private readonly storage: HandoffStorage;
  private readonly clock: Clock;
  private readonly random: Random;

  constructor(storage: HandoffStorage, clock: Clock, random: Random) {
    this.storage = storage;
    this.clock = clock;
    this.random = random;
  }

  /** Stores the text and returns the key to put in the address (`handoffFragment`). */
  async put(text: string, action: HandoffAction): Promise<string> {
    const key = this.random.uuid();
    const entry: HandoffEntry = { text, action, at: this.clock.now() };
    await this.storage.set({ [STORAGE_PREFIX + key]: entry });
    return key;
  }

  /**
   * Reads the entry and deletes it. An entry that is missing (a browser restart cleared
   * `storage.session`, it expired, or the address was opened twice), unreadable, or not an entry
   * fails with `HandoffExpired`.
   */
  async take(key: string): Promise<HandoffEntry> {
    const storageKey = STORAGE_PREFIX + key;
    let value: unknown;
    try {
      value = (await this.storage.get([storageKey]))[storageKey];
      if (value !== undefined) await this.storage.remove([storageKey]);
    } catch (err) {
      throw AppError.wrap("HandoffExpired", err).via("HandoffStore.take");
    }
    if (!isEntry(value)) {
      throw new AppError(
        "HandoffExpired",
        "The text from the web page is no longer available. Select it on the page and choose English Tutor again.",
      ).via("HandoffStore.take");
    }
    return value;
  }

  /** Deletes the entries older than `HANDOFF_MAX_AGE_MS`, and any that is not an entry. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const all = await this.storage.getAll();
    const old = Object.entries(all)
      .filter(([key, value]) => {
        if (!key.startsWith(STORAGE_PREFIX)) return false;
        return !isEntry(value) || now - value.at > HANDOFF_MAX_AGE_MS;
      })
      .map(([key]) => key);
    if (old.length > 0) await this.storage.remove(old);
    return old.length;
  }
}
