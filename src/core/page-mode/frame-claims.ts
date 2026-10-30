import type { Clock } from "../clock";
import type { HandoffStorage } from "../handoff";

/** An entry nobody claimed is deleted when the background script next runs after this long. */
export const FRAME_CLAIM_MAX_AGE_MS = 5 * 60 * 1000;

const STORAGE_PREFIX = "page-frame:";

/** A frame the content script of a tab is about to make, kept in `storage.session`. */
interface FrameEntry {
  tabId: number;
  /** Milliseconds since the epoch when the entry was stored. */
  at: number;
}

function isEntry(value: unknown): value is FrameEntry {
  if (typeof value !== "object" || value === null) return false;
  const { tabId, at } = value as Record<string, unknown>;
  return (
    typeof tabId === "number" &&
    Number.isInteger(tabId) &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

/**
 * Which page-mode frame belongs to which tab (SPEC section 4.11). A web page can make an
 * `<iframe>` of `page-ui.html` itself, with an address fragment and a port of its own choosing,
 * and so use the user's LLM. So the frame only starts when the background script confirms it:
 * the content script registers the random id of the frame it makes, with the tab it runs in (the
 * browser fills in the sender's tab, a page script cannot send the message at all), and the frame
 * claims the id, from the same tab. A claim works once and deletes the entry, whatever the
 * answer. It keeps nothing in memory, so it works across the background script's restarts.
 */
export class FrameClaims {
  private readonly storage: HandoffStorage;
  private readonly clock: Clock;

  constructor(storage: HandoffStorage, clock: Clock) {
    this.storage = storage;
    this.clock = clock;
  }

  /** Remembers that the content script of this tab makes a frame with this id. */
  async register(id: string, tabId: number): Promise<void> {
    const entry: FrameEntry = { tabId, at: this.clock.now() };
    await this.storage.set({ [STORAGE_PREFIX + id]: entry });
  }

  /**
   * True only when the id was registered, not long ago, by the tab that now claims it. The entry
   * is deleted in every case, so a second claim is refused.
   */
  async claim(id: string, tabId: number | undefined): Promise<boolean> {
    const key = STORAGE_PREFIX + id;
    const value = (await this.storage.get([key]))[key];
    if (value === undefined) return false;
    await this.storage.remove([key]);
    return (
      isEntry(value) &&
      tabId !== undefined &&
      value.tabId === tabId &&
      this.clock.now() - value.at <= FRAME_CLAIM_MAX_AGE_MS
    );
  }

  /** Deletes the entries older than `FRAME_CLAIM_MAX_AGE_MS`, and any that is not an entry. */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const old = Object.entries(await this.storage.getAll())
      .filter(([key, value]) => {
        if (!key.startsWith(STORAGE_PREFIX)) return false;
        return !isEntry(value) || now - value.at > FRAME_CLAIM_MAX_AGE_MS;
      })
      .map(([key]) => key);
    if (old.length > 0) await this.storage.remove(old);
    return old.length;
  }
}
