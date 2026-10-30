import { promptServer } from "../core/llm";
import type { Logger } from "../core/log";
import {
  PAGE_MODE_OFF,
  SETTINGS_CHANGED,
  type SiteConfig,
  type SiteRequest,
  type SiteState,
} from "../core/page-mode/messages";
import type { LLMConfig } from "../core/store";
import {
  HOST_MAX_LENGTH,
  isSiteHost,
  type Settings,
  type SiteChoice,
} from "../core/store/settings";
import type { ChangeChannel } from "../platform/channel";
import type { ContentScripts, PageModePermission, PageTabs } from "../platform/page-mode";
import type { SessionStorage } from "../platform/session-storage";

/** What page mode reads and writes in the store (`Store` fits). */
export interface PageModeSettings {
  getSetting<K extends "page_mode" | "page_mode_sites" | "selected_llm_id">(
    key: K,
  ): Promise<Settings[K]>;
  setSetting<K extends "page_mode" | "page_mode_sites">(key: K, value: Settings[K]): Promise<void>;
  listConfigs(): Promise<LLMConfig[]>;
}

export interface PageModeBackendDeps {
  /** Opens the store when it is first needed: the event page keeps nothing between events. */
  settings(): Promise<PageModeSettings>;
  permission: PageModePermission;
  scripts: ContentScripts;
  tabs: PageTabs;
  /** `storage.session`: the sites answered Not now (`page-mode-later:<host>`). */
  session: SessionStorage;
  channel: ChangeChannel;
  log: Logger;
}

/** The `storage.session` key that holds "Not now" for a site (SPEC section 4.11). */
export function laterKey(host: string): string {
  return `page-mode-later:${host}`;
}

/** The host name of a web page address, or undefined for anything that is not `http(s)`. */
export function hostOfUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.toLowerCase();
    return host === "" || host.length > HOST_MAX_LENGTH ? undefined : host;
  } catch {
    return undefined;
  }
}

/** What the toolbar button's menu shows for the active tab (SPEC section 4.11). */
export interface SiteEntry {
  visible: boolean;
  title: string;
}

/**
 * The background script's side of page mode (SPEC sections 4.11 and 7): it keeps the registered
 * content script in step with the `page_mode` setting and the `<all_urls>` permission, tells the
 * open pages, answers the content script's question what page mode does on its host, takes the
 * choices of the prompt, and turns page mode off and on for one site. It keeps nothing in memory:
 * everything is read when needed.
 */
export class PageModeBackend {
  private readonly deps: PageModeBackendDeps;

  constructor(deps: PageModeBackendDeps) {
    this.deps = deps;
  }

  /**
   * Makes the registration match the setting and the permission. If the setting is on but the
   * permission was withdrawn (in `about:addons`), page mode is switched off. With `notify` the open
   * pages are told (`page-mode-off`, or `settings-changed` when it is on).
   */
  async sync(options: { notify: boolean }): Promise<void> {
    const { permission, scripts, tabs, channel, log } = this.deps;
    const store = await this.deps.settings();
    const wanted = await store.getSetting("page_mode");
    const granted = await permission.contains();
    if (wanted && !granted) {
      await store.setSetting("page_mode", false);
      channel.post("settings-changed");
      log.info("page mode was switched off: the permission for all websites is gone");
    }
    const enabled = wanted && granted;
    const registration = await scripts.registration();
    if (enabled && registration !== "current") {
      await scripts.register();
      // The registration reaches only pages that load from now on: the pages that are open (the
      // user may have allowed page mode on the LinkedIn tab they were using) get the script now.
      const { injected, skipped } = await scripts.injectIntoOpenTabs();
      log.debug("page mode was started in the open tabs", { injected, skipped });
    } else if (!enabled && registration !== "none") {
      await scripts.unregister();
    }
    // The open pages are told before the permission can go (the options page removes it after
    // this call), and also when nothing had to change: a page may have missed an earlier message.
    if (options.notify) await tabs.broadcast(enabled ? SETTINGS_CHANGED : PAGE_MODE_OFF);
  }

  /**
   * What page mode does on `host`: `off` when page mode is not offered at all or the user chose
   * Never there, `on`, `later` (Not now, until the browser restarts), or `ask`.
   */
  async siteState(rawHost: string): Promise<SiteState> {
    const host = rawHost.toLowerCase();
    const store = await this.deps.settings();
    if (!isSiteHost(host) || !(await store.getSetting("page_mode"))) return "off";
    const sites = await store.getSetting("page_mode_sites");
    const choice = Object.hasOwn(sites, host) ? sites[host] : undefined;
    if (choice !== undefined) return choice;
    const later = await this.deps.session.get([laterKey(host)]);
    return later[laterKey(host)] === true ? "later" : "ask";
  }

  /**
   * The answer to the content script's `page-mode-config`: the site's state and, for `ask` and
   * `later` (the sites that get the dimmed badge), the server of the LLM in use (the selected one,
   * or the first by name) for the prompt's note: its host and port, never a key.
   */
  async config(host: string): Promise<SiteConfig> {
    const state = await this.siteState(host);
    if (state !== "ask" && state !== "later") return { state };
    const store = await this.deps.settings();
    const [configs, selected] = await Promise.all([
      store.listConfigs(),
      store.getSetting("selected_llm_id"),
    ]);
    const llm = configs.find((c) => c.id === selected) ?? configs[0];
    return { state, llm: llm === undefined ? null : (promptServer(llm) ?? null) };
  }

  /**
   * The choice made in the prompt of a page (SPEC section 4.11). The host must be the one of the
   * page the message came from (its address, or, for a frame with no address of its own, its
   * origin), and page mode must be offered. Turn on and Never are stored; `later` is kept in
   * `storage.session` until the browser restarts. The other pages are told. Returns whether the
   * choice was taken.
   */
  async chooseSite(
    request: SiteRequest,
    sender: { url: string | undefined; origin: string | undefined },
  ): Promise<boolean> {
    if ((hostOfUrl(sender.url) ?? hostOfUrl(sender.origin)) !== request.host) return false;
    const store = await this.deps.settings();
    if (!(await store.getSetting("page_mode"))) return false;
    if (request.choice === "later") {
      await this.deps.session.set({ [laterKey(request.host)]: true });
      await this.announce();
    } else {
      await this.setSite(request.host, request.choice);
    }
    return true;
  }

  /** The toolbar menu's entry for the active tab: Turn on / Turn off on <host>. */
  async siteEntry(url: string | undefined): Promise<SiteEntry> {
    const host = hostOfUrl(url);
    if (host === undefined) return { visible: false, title: "" };
    const store = await this.deps.settings();
    if (!(await store.getSetting("page_mode"))) return { visible: false, title: "" };
    const on = (await this.siteState(host)) === "on";
    return { visible: true, title: on ? `Turn off on ${host}` : `Turn on on ${host}` };
  }

  /** Turns page mode off on the host of the address if it is on there, and on if it is not. */
  async toggleSite(url: string | undefined): Promise<void> {
    const host = hostOfUrl(url);
    if (host === undefined) return;
    const store = await this.deps.settings();
    if (!(await store.getSetting("page_mode"))) return;
    const on = (await this.siteState(host)) === "on";
    await this.setSite(host, on ? "off" : "on");
  }

  /** Stores the choice, forgets Not now, and tells the open pages. */
  private async setSite(host: string, choice: SiteChoice): Promise<void> {
    const store = await this.deps.settings();
    const sites = await store.getSetting("page_mode_sites");
    await store.setSetting("page_mode_sites", { ...sites, [host]: choice });
    await this.deps.session.remove([laterKey(host)]);
    await this.announce();
  }

  private async announce(): Promise<void> {
    this.deps.channel.post("settings-changed");
    await this.deps.tabs.broadcast(SETTINGS_CHANGED);
  }
}
