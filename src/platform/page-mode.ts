import { AppError } from "../core/errors";
import {
  PAGE_FRAME_CLAIM,
  PAGE_FRAME_REGISTER,
  PAGE_MODE_CONFIG,
  PAGE_MODE_OPEN_OPTIONS,
  PAGE_MODE_OPEN_TUTOR,
  PAGE_MODE_SITE,
  parseBroadcast,
  parseSiteConfig,
  type PageBroadcast,
  type PromptChoice,
  type SiteConfig,
} from "../core/page-mode/messages";

/** The match pattern page mode asks for: every web page (SPEC sections 3.2 and 4.11). */
export const ALL_URLS = "<all_urls>";
/**
 * The pages page mode runs on. Access to them is what `contains` asks about: Firefox records
 * these two optional patterns as granted next to `<all_urls>` at installation (checked in Firefox
 * 159), and `<all_urls>` also lists `file:` and other schemes that the content script never
 * reaches.
 */
export const WEB_PAGES = ["http://*/*", "https://*/*"];
/** The bundle of the content script (`src/content/main.ts`), declared in the manifest. */
export const PAGE_MODE_SCRIPT_FILE = "page.js";

/**
 * The `<all_urls>` host permission of page mode. Firefox grants it when the extension is installed
 * (`host_permissions` in the manifest), and the user can withdraw it again, for a site or entirely
 * (the extensions panel, `about:addons`). The only place that calls `browser.permissions` for it
 * (the LLM origins are `HostPermissions`).
 */
export interface PageModePermission {
  /** Whether access to all web pages (`http` and `https`) is granted now. */
  contains(): Promise<boolean>;
  /** Whether the extension may use the site of this page address: false when the user withdrew it. */
  containsSite(pageUrl: string): Promise<boolean>;
  /**
   * Asks for the permission again; true when it is (now) granted. Firefox accepts the call only
   * during a user gesture, so a click handler calls it synchronously, before any `await`.
   */
  request(): Promise<boolean>;
  /** The user (or the browser) withdrew a permission. Registered at the top level. */
  onRemoved(handler: () => void): void;
  /** A permission was granted (the user allowed it again). Registered at the top level. */
  onAdded(handler: () => void): void;
}

export class BrowserPageModePermission implements PageModePermission {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  contains(): Promise<boolean> {
    return this.api.permissions.contains({ origins: WEB_PAGES });
  }

  async containsSite(pageUrl: string): Promise<boolean> {
    try {
      const { protocol, hostname } = new URL(pageUrl);
      // A match pattern has no port (`hostname` keeps the brackets of an IPv6 address).
      return await this.api.permissions.contains({ origins: [`${protocol}//${hostname}/*`] });
    } catch {
      // An address or a pattern the browser does not accept (an opaque origin): no access to it.
      return false;
    }
  }

  // Not `async`: the call to the browser must happen in the same turn as the click.
  request(): Promise<boolean> {
    return this.api.permissions.request({ origins: [ALL_URLS] });
  }

  onRemoved(handler: () => void): void {
    this.api.permissions.onRemoved.addListener(() => {
      handler();
    });
  }

  onAdded(handler: () => void): void {
    this.api.permissions.onAdded.addListener(() => {
      handler();
    });
  }
}

/** The tabs a script was run in, and the tabs it could not be run in (pages the extension cannot reach). */
export interface Injection {
  injected: number;
  skipped: number;
}

/**
 * The content script of page mode (SPEC section 4.11). The manifest declares it, so Firefox runs
 * it in every page that loads; this only runs it in the pages that are already open. Only
 * `browser.scripting`.
 */
export interface ContentScripts {
  /**
   * Runs the script once in every `http(s)` tab that is open now, in all its frames: a content
   * script declared in the manifest reaches only pages that load after the installation or the
   * update, and the old copy of a script from before an update is dead. The script starts once per
   * frame (`claimPageSlot`), so a page that has both runs one.
   */
  injectIntoOpenTabs(): Promise<Injection>;
}

export class BrowserContentScripts implements ContentScripts {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  async injectIntoOpenTabs(): Promise<Injection> {
    const tabs = await this.api.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const results = await Promise.all(
      tabs.map(async (tab): Promise<boolean> => {
        if (tab.id === undefined) return false;
        try {
          await this.api.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: [PAGE_MODE_SCRIPT_FILE],
          });
          return true;
        } catch {
          // A tab the extension cannot script (a discarded tab, a page of the browser, a site the
          // user withdrew access to): skipped.
          return false;
        }
      }),
    );
    const injected = results.filter(Boolean).length;
    return { injected, skipped: results.length - injected };
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

/** Who sent a message to the background script: only what it needs. */
export interface MessageSender {
  /** Whether it is this extension's own code. */
  ownExtension: boolean;
  /** The address of the page or frame the sender runs in (a content script's page), if known. */
  url: string | undefined;
  /**
   * The origin of the document the sender runs in, as the browser knows it: for a frame with no
   * address of its own (`about:blank`, `about:srcdoc`, `blob:`) it is the origin of the page that
   * made it, which `url` does not say.
   */
  origin: string | undefined;
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
        url: sender.url,
        origin: "origin" in sender && typeof sender.origin === "string" ? sender.origin : undefined,
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
  /** What page mode does on this host: its state, and for `ask` the LLM server for the prompt. */
  configFor(host: string): Promise<SiteConfig>;
  /** Tells the background script the choice made in the prompt (SPEC section 4.11). */
  chooseSite(host: string, choice: PromptChoice): Promise<void>;
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

  async configFor(host: string): Promise<SiteConfig> {
    const answer: unknown = await this.api.runtime.sendMessage({ type: PAGE_MODE_CONFIG, host });
    // An answer that makes no sense is "off": nothing is read.
    return parseSiteConfig(answer) ?? { state: "off" };
  }

  async chooseSite(host: string, choice: PromptChoice): Promise<void> {
    await this.api.runtime.sendMessage({ type: PAGE_MODE_SITE, host, choice });
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

/**
 * What the issues dialog asks of the background script (SPEC section 4.11). The frame has no
 * `tabs` and no `runtime.openOptionsPage`, so both go through `runtime` messages. A failure is
 * `PageDialogActionFailed`.
 */
export interface FrameActions {
  /** Opens a new tutor tab, after the page's tab, with the text (the hand-off of SPEC section 4.1). */
  openInTutor(text: string): Promise<void>;
  /** Opens the options page. */
  openOptions(): Promise<void>;
}

export class BrowserFrameActions implements FrameActions {
  private readonly api: typeof browser;

  constructor(api: typeof browser) {
    this.api = api;
  }

  openInTutor(text: string): Promise<void> {
    return this.send({ type: PAGE_MODE_OPEN_TUTOR, text }, "BrowserFrameActions.openInTutor");
  }

  openOptions(): Promise<void> {
    return this.send({ type: PAGE_MODE_OPEN_OPTIONS }, "BrowserFrameActions.openOptions");
  }

  /** The background script answers `{ ok: true }` when it did what was asked. */
  private async send(message: { type: string; text?: string }, where: string): Promise<void> {
    let answer: unknown;
    try {
      answer = await this.api.runtime.sendMessage(message);
    } catch (err) {
      throw AppError.wrap("PageDialogActionFailed", err, { type: message.type }).via(where);
    }
    if (typeof answer !== "object" || answer === null || (answer as { ok?: unknown }).ok !== true) {
      throw new AppError("PageDialogActionFailed", "English Tutor could not be opened from here.", {
        type: message.type,
      }).via(where);
    }
  }
}
