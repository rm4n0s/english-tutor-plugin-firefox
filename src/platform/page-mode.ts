import {
  PAGE_FRAME_CLAIM,
  PAGE_FRAME_REGISTER,
  PAGE_MODE_APPLY,
  PAGE_MODE_CONFIG,
  PAGE_MODE_OPEN_TUTOR,
  parseBroadcast,
  type PageBroadcast,
} from "../core/page-mode/messages";

/** The match pattern page mode asks for: every web page (SPEC sections 3.2 and 4.11). */
export const ALL_URLS = "<all_urls>";
/** The id of the registered content script. */
export const PAGE_MODE_SCRIPT_ID = "page-mode";
/** The bundle the script registers (`src/content/main.ts`). */
export const PAGE_MODE_SCRIPT_FILE = "page.js";

/**
 * The `<all_urls>` host permission of page mode. The only place that calls `browser.permissions`
 * for it (the LLM origins are `HostPermissions`).
 */
export interface PageModePermission {
  contains(): Promise<boolean>;
  /**
   * Asks for the permission; true when it is (now) granted. Firefox accepts the call only during
   * a user gesture, so a click handler calls it synchronously, before any `await`.
   */
  request(): Promise<boolean>;
  /** Gives the permission back; true when it was removed. */
  remove(): Promise<boolean>;
  /** The user (or the extension) removed a permission. Registered at the top level. */
  onRemoved(handler: () => void): void;
}

export class BrowserPageModePermission implements PageModePermission {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  contains(): Promise<boolean> {
    return this.api.permissions.contains({ origins: [ALL_URLS] });
  }

  // Not `async`: the call to the browser must happen in the same turn as the click.
  request(): Promise<boolean> {
    return this.api.permissions.request({ origins: [ALL_URLS] });
  }

  remove(): Promise<boolean> {
    return this.api.permissions.remove({ origins: [ALL_URLS] });
  }

  onRemoved(handler: () => void): void {
    this.api.permissions.onRemoved.addListener(() => {
      handler();
    });
  }
}

/** The registered content script of page mode (SPEC section 4.11). Only `browser.scripting`. */
export interface ContentScripts {
  isRegistered(): Promise<boolean>;
  register(): Promise<void>;
  unregister(): Promise<void>;
}

export class BrowserContentScripts implements ContentScripts {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async isRegistered(): Promise<boolean> {
    const found = await this.api.scripting.getRegisteredContentScripts({
      ids: [PAGE_MODE_SCRIPT_ID],
    });
    return found.length > 0;
  }

  async register(): Promise<void> {
    await this.api.scripting.registerContentScripts([
      {
        id: PAGE_MODE_SCRIPT_ID,
        matches: [ALL_URLS],
        js: [PAGE_MODE_SCRIPT_FILE],
        runAt: "document_idle",
        allFrames: true,
      },
    ]);
  }

  async unregister(): Promise<void> {
    await this.api.scripting.unregisterContentScripts({ ids: [PAGE_MODE_SCRIPT_ID] });
  }
}

/**
 * The background script's way to reach the pages that run the content script. It needs no
 * permission: `tabs.query({})` returns ids, and a tab without a receiver is ignored.
 */
export interface PageTabs {
  broadcast(message: PageBroadcast): Promise<void>;
}

export class BrowserPageTabs implements PageTabs {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async broadcast(message: PageBroadcast): Promise<void> {
    const tabs = await this.api.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await this.api.tabs.sendMessage(tab.id, { type: message });
        } catch {
          // No page-mode content script in this tab ("Receiving end does not exist").
        }
      }),
    );
  }
}

/** What the options page asks of the background script. */
export interface PageModeBackendLink {
  /** Registers or unregisters the content script to match the setting and the permission. */
  apply(): Promise<void>;
}

export class BrowserPageModeBackendLink implements PageModeBackendLink {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async apply(): Promise<void> {
    await this.api.runtime.sendMessage({ type: PAGE_MODE_APPLY });
  }
}

/** Who sent a message to the background script: only what it needs. */
export interface MessageSender {
  /** Whether it is this extension's own code. */
  ownExtension: boolean;
  tab: { id: number; windowId: number; index: number } | undefined;
}

/** The background script's `runtime.onMessage`. */
export interface BackgroundMessages {
  /**
   * Registers the listener at the top level. It returns a promise for a message it answers, and
   * undefined for one that is not its own (the browser then leaves it to the other listeners).
   */
  onMessage(
    handler: (message: unknown, sender: MessageSender) => Promise<unknown> | undefined,
  ): void;
}

export class BrowserBackgroundMessages implements BackgroundMessages {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  onMessage(
    handler: (message: unknown, sender: MessageSender) => Promise<unknown> | undefined,
  ): void {
    this.api.runtime.onMessage.addListener((message: unknown, sender) => {
      const tab = sender.tab;
      return handler(message, {
        ownExtension: sender.id === this.api.runtime.id,
        tab:
          tab?.id === undefined || tab.windowId === undefined
            ? undefined
            : { id: tab.id, windowId: tab.windowId, index: tab.index },
      });
    });
  }
}

/** The content script's link to the extension. */
export interface PageModeRuntime {
  /** Whether page mode runs on this host (the setting and the per-site list). */
  enabledOn(host: string): Promise<boolean>;
  /** Opens a new tutor tab with the text (the hand-off of SPEC section 4.1). */
  openInTutor(text: string): Promise<void>;
  /** Tells the background script the id of the frame about to be made (SPEC section 4.11). */
  registerFrame(id: string): Promise<void>;
  /** The messages the background script sends: `page-mode-off` and `settings-changed`. */
  onBroadcast(handler: (message: PageBroadcast) => void): () => void;
  /** The address of the frame; `fragment` is its id. */
  frameUrl(fragment: string): string;
}

export class BrowserPageModeRuntime implements PageModeRuntime {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async enabledOn(host: string): Promise<boolean> {
    const answer: unknown = await this.api.runtime.sendMessage({ type: PAGE_MODE_CONFIG, host });
    return (
      typeof answer === "object" &&
      answer !== null &&
      (answer as { enabled?: unknown }).enabled === true
    );
  }

  async registerFrame(id: string): Promise<void> {
    await this.api.runtime.sendMessage({ type: PAGE_FRAME_REGISTER, id });
  }

  async openInTutor(text: string): Promise<void> {
    await this.api.runtime.sendMessage({ type: PAGE_MODE_OPEN_TUTOR, text });
  }

  onBroadcast(handler: (message: PageBroadcast) => void): () => void {
    // Returns undefined: the content script never answers a message (it ignores tutor-ping).
    const listener = (message: unknown): undefined => {
      const broadcast = parseBroadcast(message);
      if (broadcast !== undefined) handler(broadcast);
      return undefined;
    };
    this.api.runtime.onMessage.addListener(listener);
    return () => {
      this.api.runtime.onMessage.removeListener(listener);
    };
  }

  frameUrl(fragment: string): string {
    return `${this.api.runtime.getURL("page-ui.html")}#${fragment}`;
  }
}

/** The page-mode frame's question to the background script: am I the frame that was registered? */
export interface FrameClaim {
  /** True when the background script registered this id for the tab this frame is in. */
  claim(id: string): Promise<boolean>;
}

export class BrowserFrameClaim implements FrameClaim {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async claim(id: string): Promise<boolean> {
    const answer: unknown = await this.api.runtime.sendMessage({ type: PAGE_FRAME_CLAIM, id });
    return (
      typeof answer === "object" &&
      answer !== null &&
      (answer as { granted?: unknown }).granted === true
    );
  }
}
