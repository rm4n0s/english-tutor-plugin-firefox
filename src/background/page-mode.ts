import type { Logger } from "../core/log";
import { PAGE_MODE_OFF, SETTINGS_CHANGED } from "../core/page-mode/messages";
import { HOST_MAX_LENGTH, type Settings } from "../core/store/settings";
import type { ChangeChannel } from "../platform/channel";
import type { ContentScripts, PageModePermission, PageTabs } from "../platform/page-mode";

/** The two settings page mode keeps (`Store` fits). */
export interface PageModeSettings {
  getSetting<K extends "page_mode" | "page_mode_off_hosts">(key: K): Promise<Settings[K]>;
  setSetting<K extends "page_mode" | "page_mode_off_hosts">(
    key: K,
    value: Settings[K],
  ): Promise<void>;
}

export interface PageModeBackendDeps {
  /** Opens the store when it is first needed: the event page keeps nothing between events. */
  settings(): Promise<PageModeSettings>;
  permission: PageModePermission;
  scripts: ContentScripts;
  tabs: PageTabs;
  channel: ChangeChannel;
  log: Logger;
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
 * open pages, answers the content script's question whether it should run on its host, and turns
 * page mode off and on for one site. It keeps nothing in memory: everything is read when needed.
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
    const registered = await scripts.isRegistered();
    if (enabled && !registered) await scripts.register();
    else if (!enabled && registered) await scripts.unregister();
    // The open pages are told before the permission can go (the options page removes it after
    // this call), and also when nothing had to change: a page may have missed an earlier message.
    if (options.notify) await tabs.broadcast(enabled ? SETTINGS_CHANGED : PAGE_MODE_OFF);
  }

  /** Whether page mode runs on `host`: it is on, and the host is not in the per-site list. */
  async enabledOn(host: string): Promise<boolean> {
    const store = await this.deps.settings();
    if (!(await store.getSetting("page_mode"))) return false;
    const off = await store.getSetting("page_mode_off_hosts");
    return !off.includes(host.toLowerCase());
  }

  /** The toolbar menu's entry for the active tab: Turn off / Turn on on <host>. */
  async siteEntry(url: string | undefined): Promise<SiteEntry> {
    const host = hostOfUrl(url);
    if (host === undefined) return { visible: false, title: "" };
    const store = await this.deps.settings();
    if (!(await store.getSetting("page_mode"))) return { visible: false, title: "" };
    const off = (await store.getSetting("page_mode_off_hosts")).includes(host);
    return { visible: true, title: off ? `Turn on on ${host}` : `Turn off on ${host}` };
  }

  /** Turns page mode off on the host of the address, or on again if it was off there. */
  async toggleSite(url: string | undefined): Promise<void> {
    const host = hostOfUrl(url);
    if (host === undefined) return;
    const store = await this.deps.settings();
    const off = await store.getSetting("page_mode_off_hosts");
    const next = off.includes(host) ? off.filter((h) => h !== host) : [...off, host];
    await store.setSetting("page_mode_off_hosts", next);
    this.deps.channel.post("settings-changed");
    await this.deps.tabs.broadcast(SETTINGS_CHANGED);
  }
}
