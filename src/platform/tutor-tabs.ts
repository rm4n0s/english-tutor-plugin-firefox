/** The message the background script sends to find the tutor pages (SPEC section 4.1). */
export const TUTOR_PING = "tutor-ping";

/** What a tutor page answers to a ping. */
export interface TutorTabInfo {
  tabId: number;
  windowId: number;
  /** Milliseconds since the epoch when the tab was last focused (0 if it never was). */
  focusedAt: number;
  /** Whether the tab's text has unsaved changes. */
  dirty: boolean;
}

/** Whether a message is the ping. */
export function isTutorPing(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === TUTOR_PING
  );
}

/** The answer of a tutor page, or undefined for anything else (another page, no answer). */
export function parseTutorTabInfo(value: unknown): TutorTabInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { tabId, windowId, focusedAt, dirty } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(tabId) || !Number.isSafeInteger(windowId)) return undefined;
  if (typeof focusedAt !== "number" || !Number.isFinite(focusedAt)) return undefined;
  if (typeof dirty !== "boolean") return undefined;
  return { tabId: tabId as number, windowId: windowId as number, focusedAt, dirty };
}

/** Where a new tutor tab goes: right after the tab the web page menu was used in. */
export interface TabPlace {
  windowId: number;
  index: number;
}

/**
 * The background script's view of the tutor pages (SPEC section 4.1). The only place that calls
 * `browser.tabs` and `browser.windows` for them. It needs no `tabs` permission: `tabs.query({})`
 * returns ids without addresses, and a tutor page answers `tabs.sendMessage`.
 */
export interface TutorTabs {
  /** Asks every tab; those that are tutor pages answer. Never rejects for a tab that does not. */
  ping(): Promise<TutorTabInfo[]>;
  /** Brings the tab and its window to the front. */
  focus(tab: { tabId: number; windowId: number }): Promise<void>;
  /**
   * Opens a new tutor tab. `fragment` (for example `#handoff=<key>`) is added to the address.
   * Without `after` the browser puts it in the current window.
   */
  open(options?: { fragment?: string; after?: TabPlace }): Promise<void>;
}

export class BrowserTutorTabs implements TutorTabs {
  private readonly api: typeof browser;
  private readonly page: string;

  constructor(api: typeof browser, page: string) {
    this.api = api;
    this.page = page;
  }

  async ping(): Promise<TutorTabInfo[]> {
    const tabs = await this.api.tabs.query({});
    const answers = await Promise.all(
      tabs.map(async (tab): Promise<TutorTabInfo | undefined> => {
        if (tab.id === undefined) return undefined;
        try {
          const answer: unknown = await this.api.tabs.sendMessage(tab.id, { type: TUTOR_PING });
          return parseTutorTabInfo(answer);
        } catch {
          // A tab without a tutor page has nobody to answer ("Receiving end does not exist").
          return undefined;
        }
      }),
    );
    return answers.filter((answer) => answer !== undefined);
  }

  async focus(tab: { tabId: number; windowId: number }): Promise<void> {
    await this.api.tabs.update(tab.tabId, { active: true });
    await this.api.windows.update(tab.windowId, { focused: true });
  }

  async open(options: { fragment?: string; after?: TabPlace } = {}): Promise<void> {
    const url = this.api.runtime.getURL(this.page) + (options.fragment ?? "");
    await this.api.tabs.create(
      options.after === undefined
        ? { url }
        : { url, windowId: options.after.windowId, index: options.after.index + 1 },
    );
  }
}

/** The tutor page's side: it answers the ping. */
export interface TutorPingResponder {
  /** `answer` is called for each ping. Returns the function that removes the listener. */
  onPing(answer: () => Promise<TutorTabInfo | undefined>): () => void;
}

export class BrowserTutorPingResponder implements TutorPingResponder {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  onPing(answer: () => Promise<TutorTabInfo | undefined>): () => void {
    // Returning a promise answers the sender; returning undefined leaves the message to others.
    const listener = (message: unknown): Promise<TutorTabInfo | undefined> | undefined =>
      isTutorPing(message) ? answer() : undefined;
    this.api.runtime.onMessage.addListener(listener);
    return () => {
      this.api.runtime.onMessage.removeListener(listener);
    };
  }
}
