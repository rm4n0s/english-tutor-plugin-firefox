import { handoffFragment, type HandoffAction, type HandoffStore } from "../core/handoff";
import type { Logger } from "../core/log";
import {
  PAGE_FRAME_CLAIM,
  PAGE_FRAME_REGISTER,
  PAGE_MODE_APPLY,
  PAGE_MODE_CONFIG,
  PAGE_MODE_IGNORE,
  PAGE_MODE_OPEN_TUTOR,
  PAGE_MODE_SITE,
  messageType,
  parseConfigRequest,
  parseFrameIdRequest,
  parseIgnoreRequest,
  parseOpenTutorRequest,
  parseSiteRequest,
} from "../core/page-mode/messages";
import type { FrameClaims } from "../core/page-mode/frame-claims";
import type { IgnoreSet } from "../core/store";
import type { Commands } from "../platform/commands";
import type { Lifecycle } from "../platform/lifecycle";
import type { Notifier } from "../platform/notifications";
import type { OptionsOpener } from "../platform/options-page";
import type { BackgroundMessages, PageModePermission } from "../platform/page-mode";
import type { ToolbarButton } from "../platform/toolbar-button";
import type { TabPlace, TutorTabInfo, TutorTabs } from "../platform/tutor-tabs";
import type { BackgroundMenus, WebMenuClick, WebMenuItem } from "../platform/web-menus";
import type { PageModeBackend } from "./page-mode";

export const TUTOR_PAGE = "tutor.html";
/** The command of the manifest that brings the tutor page to the front. */
export const OPEN_TUTOR_COMMAND = "open-tutor";

export const MENU_IDS = {
  webParent: "english-tutor-web",
  webCheck: "english-tutor-web-check",
  webAlternatives: "english-tutor-web-alternatives",
  newTab: "english-tutor-action-new-tab",
  preferences: "english-tutor-action-preferences",
  /** Turn on / Turn off page mode on the active tab's host (SPEC section 4.11). */
  pageModeSite: "english-tutor-action-page-mode-site",
} as const;

/**
 * The web page entries are limited to web pages, so they do not show in the extension's own pages
 * (the tutor page has its own menu, SPEC section 4.3) or in the browser's.
 */
export const WEB_PAGE_PATTERNS = ["http://*/*", "https://*/*", "file:///*"] as const;

/** The entries of the web page menu (a submenu) and of the toolbar button's menu (SPEC section 4.1). */
export const MENU_ITEMS: readonly WebMenuItem[] = [
  {
    id: MENU_IDS.webParent,
    title: "English Tutor",
    contexts: ["selection"],
    documentUrlPatterns: WEB_PAGE_PATTERNS,
  },
  {
    id: MENU_IDS.webCheck,
    title: "Check with English Tutor",
    contexts: ["selection"],
    parentId: MENU_IDS.webParent,
    documentUrlPatterns: WEB_PAGE_PATTERNS,
  },
  {
    id: MENU_IDS.webAlternatives,
    title: "Alternatives with English Tutor",
    contexts: ["selection"],
    parentId: MENU_IDS.webParent,
    documentUrlPatterns: WEB_PAGE_PATTERNS,
  },
  { id: MENU_IDS.newTab, title: "New tutor tab", contexts: ["action"] },
  { id: MENU_IDS.preferences, title: "Preferences", contexts: ["action"] },
  // Made hidden; `menus.onShown` gives it its title and shows it while page mode is on.
  {
    id: MENU_IDS.pageModeSite,
    title: "Page mode on this site",
    contexts: ["action"],
    visible: false,
  },
];

const CHECK_NOTIFICATION = /^check-(\d+)$/;

export interface BackgroundDeps {
  button: ToolbarButton;
  commands: Commands;
  menus: BackgroundMenus;
  tabs: TutorTabs;
  handoff: HandoffStore;
  notifier: Notifier;
  lifecycle: Lifecycle;
  options: OptionsOpener;
  /** Page mode: registration, the sites and the content script's questions. */
  pageMode: PageModeBackend;
  /** Which frame belongs to which tab: a page cannot make a frame of its own (SPEC section 4.11). */
  frameClaims: FrameClaims;
  /** The Not-an-error ignore set, for the page-mode frame, which has no `storage.session` (SPEC section 5.7). */
  ignore: IgnoreSet;
  permission: PageModePermission;
  messages: BackgroundMessages;
  log: Logger;
}

/** The tutor tab to bring to the front: the one focused last (the later one on a tie). */
export function latestTutorTab(tabs: readonly TutorTabInfo[]): TutorTabInfo | undefined {
  let latest: TutorTabInfo | undefined;
  for (const tab of tabs) {
    if (
      latest === undefined ||
      tab.focusedAt > latest.focusedAt ||
      (tab.focusedAt === latest.focusedAt && tab.tabId > latest.tabId)
    ) {
      latest = tab;
    }
  }
  return latest;
}

/**
 * The background script (SPEC sections 4.1, 4.10 and 7). `startBackground` registers every
 * listener synchronously, as the browser needs for an event page, and keeps no state: the tutor
 * pages are asked when needed, and the hand-off text is in `storage.session`. It never calls an
 * LLM.
 */
export function startBackground(deps: BackgroundDeps): void {
  const { button, commands, menus, tabs, handoff, notifier, lifecycle, options, log } = deps;
  const { pageMode, frameClaims, ignore, permission, messages } = deps;

  const report = (message: string) => (err: unknown) => {
    log.error(message, { err });
  };

  // The toolbar button and the open-tutor command: the latest tutor tab, or a new one.
  async function showTutor(): Promise<void> {
    const latest = latestTutorTab(await tabs.ping());
    if (latest === undefined) await tabs.open();
    else await tabs.focus(latest);
  }
  button.onClick(() => {
    showTutor().catch(report("could not open the tutor page"));
  });
  commands.onCommand((name) => {
    if (name === OPEN_TUTOR_COMMAND) showTutor().catch(report("could not open the tutor page"));
  });

  // The menus. The browser keeps them between runs of the event page; they are made when the
  // extension is installed, updated or loaded, and when the browser starts.
  const install = (): void => {
    menus.install(MENU_ITEMS).catch(report("could not make the menus"));
  };
  // Page mode: the registration follows the setting and the permission (SPEC section 4.11).
  const syncPageMode = (notify: boolean): void => {
    pageMode.sync({ notify }).catch(report("could not bring page mode in step with its setting"));
  };
  lifecycle.onInstalled((reason) => {
    install();
    syncPageMode(false);
    // A first installation (and a temporary add-on, which reports the same) shows the welcome
    // page, which asks once for access to all websites. An update does not (SPEC section 4.11).
    if (reason === "install") {
      options.openWelcome().catch(report("could not open the welcome page"));
    }
  });
  lifecycle.onStartup(() => {
    install();
    syncPageMode(false);
  });
  permission.onRemoved(() => {
    syncPageMode(true);
  });

  // The hand-off: the text goes through `storage.session`, never through the address.
  async function sendToTutor(
    action: HandoffAction,
    text: string,
    place: TabPlace | undefined,
  ): Promise<void> {
    const key = await handoff.put(text, action);
    await tabs.open(
      place === undefined
        ? { fragment: handoffFragment(key) }
        : {
            fragment: handoffFragment(key),
            after: place,
          },
    );
  }
  menus.onClicked((click: WebMenuClick) => {
    const place =
      click.tab === undefined
        ? undefined
        : { windowId: click.tab.windowId, index: click.tab.index };
    const text = click.selectionText ?? "";
    if (click.id === MENU_IDS.webCheck || click.id === MENU_IDS.webAlternatives) {
      if (text.trim() === "") return;
      const action = click.id === MENU_IDS.webCheck ? "check" : "alternatives";
      sendToTutor(action, text, place).catch(
        report("could not send the selection to the tutor page"),
      );
    } else if (click.id === MENU_IDS.newTab) {
      tabs.open().catch(report("could not open the tutor page"));
    } else if (click.id === MENU_IDS.preferences) {
      options.open().catch(report("could not open the options page"));
    } else if (click.id === MENU_IDS.pageModeSite) {
      pageMode.toggleSite(click.tab?.url).catch(report("could not change page mode for the site"));
    }
  });
  // The toolbar button's menu names the active tab's host (SPEC section 4.11). The entry is
  // changed and the open menu drawn again once the setting has been read.
  menus.onShown(({ contexts, tabUrl }) => {
    if (!contexts.includes("action")) return;
    const show = async (): Promise<void> => {
      const entry = await pageMode.siteEntry(tabUrl);
      await menus.update(
        MENU_IDS.pageModeSite,
        entry.visible ? { title: entry.title, visible: true } : { visible: false },
      );
      await menus.refresh();
    };
    show().catch(report("could not update the page mode menu entry"));
  });

  // Messages from the options page and from the page-mode content script. Anything that is not
  // ours is left alone (undefined): the content script never answers, and tutor pages answer pings.
  messages.onMessage((message, sender) => {
    if (!sender.ownExtension) return undefined;
    const type = messageType(message);
    if (type === PAGE_MODE_APPLY) {
      return pageMode.sync({ notify: true }).then(() => ({ ok: true }));
    }
    if (type === PAGE_MODE_CONFIG) {
      const request = parseConfigRequest(message);
      if (request === undefined) return undefined;
      return pageMode.config(request.host);
    }
    if (type === PAGE_MODE_SITE) {
      // The choice of the prompt, from the content script of a tab; the host must be the page's.
      const request = parseSiteRequest(message);
      if (request === undefined || sender.tab === undefined) return undefined;
      return pageMode.chooseSite(request, sender.url).then((ok) => ({ ok }));
    }
    if (type === PAGE_FRAME_REGISTER) {
      // From the content script of a tab; the browser says which tab. A message without a tab
      // (from an extension page that is not in a tab) registers nothing.
      const request = parseFrameIdRequest(message, PAGE_FRAME_REGISTER);
      if (request === undefined || sender.tab === undefined) return undefined;
      return frameClaims.register(request.id, sender.tab.id).then(() => ({ ok: true }));
    }
    if (type === PAGE_FRAME_CLAIM) {
      const request = parseFrameIdRequest(message, PAGE_FRAME_CLAIM);
      if (request === undefined) return undefined;
      return frameClaims.claim(request.id, sender.tab?.id).then((granted) => ({ granted }));
    }
    if (type === PAGE_MODE_IGNORE) {
      // From the page-mode frame (an extension page in a tab): the ignore set it cannot reach.
      const request = parseIgnoreRequest(message);
      if (request === undefined || sender.tab === undefined) return undefined;
      if (request.op === "move") {
        return ignore.move(request.from, request.to).then(() => ({ ok: true }));
      }
      if (request.op === "add") {
        return ignore.add(request.source, request.fingerprint).then(() => ({ ok: true }));
      }
      return ignore.has(request.source, request.fingerprint).then((has) => ({ has }));
    }
    if (type === PAGE_MODE_OPEN_TUTOR) {
      const request = parseOpenTutorRequest(message);
      if (request === undefined) return undefined;
      // A text box that was blocked from showing its panel: the text goes to a new tutor tab,
      // right after the tab it came from, through the hand-off of SPEC section 4.1.
      const place =
        sender.tab === undefined
          ? undefined
          : { windowId: sender.tab.windowId, index: sender.tab.index };
      return sendToTutor("check", request.text, place).then(() => ({ ok: true }));
    }
    return undefined;
  });

  // A click on the notification of a finished check: its tab and window come to the front.
  notifier.onClicked((id) => {
    const match = CHECK_NOTIFICATION.exec(id);
    if (match === null) return;
    const tabId = Number(match[1]);
    const focus = async (): Promise<void> => {
      const tab = (await tabs.ping()).find((t) => t.tabId === tabId);
      if (tab !== undefined) await tabs.focus(tab);
      await notifier.clear(id);
    };
    focus().catch(report("could not show the tab of the finished check"));
  });

  // An update closes the extension's tabs, so it waits while one has unsaved changes. If it
  // waits, the browser installs it at its next start.
  lifecycle.onUpdateAvailable(() => {
    tabs
      .ping()
      .then((found) => {
        if (found.every((tab) => !tab.dirty)) lifecycle.reload();
        else log.info("an update waits for the tutor tabs with unsaved changes", {});
      })
      .catch(report("could not ask the tutor pages about the update"));
  });

  // Hand-off entries nobody took are deleted when the background script next runs.
  handoff.sweep().catch(report("could not delete old hand-off entries"));
  frameClaims.sweep().catch(report("could not delete old page-mode frame entries"));
}
