import { countWords } from "../core/analysis/text";
import { MAX_ALTERNATIVES_WORDS } from "../core/analysis/alternatives";
import { handoffFragment, type HandoffAction, type HandoffStore } from "../core/handoff";
import type { Logger } from "../core/log";
import type { Commands } from "../platform/commands";
import type { Lifecycle } from "../platform/lifecycle";
import type { Notifier } from "../platform/notifications";
import type { OptionsOpener } from "../platform/options-page";
import type { ToolbarButton } from "../platform/toolbar-button";
import type { TabPlace, TutorTabInfo, TutorTabs } from "../platform/tutor-tabs";
import type {
  BackgroundMenus,
  WebMenuClick,
  WebMenuItem,
  WebMenuShown,
} from "../platform/web-menus";

export const TUTOR_PAGE = "tutor.html";
/** The command of the manifest that brings the tutor page to the front. */
export const OPEN_TUTOR_COMMAND = "open-tutor";

export const MENU_IDS = {
  webParent: "english-tutor-web",
  webCheck: "english-tutor-web-check",
  webAlternatives: "english-tutor-web-alternatives",
  newTab: "english-tutor-action-new-tab",
  preferences: "english-tutor-action-preferences",
} as const;

/** The entries of the web page menu (a submenu) and of the toolbar button's menu (SPEC section 4.1). */
export const MENU_ITEMS: readonly WebMenuItem[] = [
  { id: MENU_IDS.webParent, title: "English Tutor", contexts: ["selection"] },
  {
    id: MENU_IDS.webCheck,
    title: "Check with English Tutor",
    contexts: ["selection"],
    parentId: MENU_IDS.webParent,
  },
  {
    id: MENU_IDS.webAlternatives,
    title: "Alternatives with English Tutor",
    contexts: ["selection"],
    parentId: MENU_IDS.webParent,
  },
  { id: MENU_IDS.newTab, title: "New tutor tab", contexts: ["action"] },
  { id: MENU_IDS.preferences, title: "Preferences", contexts: ["action"] },
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
  lifecycle.onInstalled(install);
  lifecycle.onStartup(install);

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
    }
  });
  // Alternatives are offered for at most 600 words. The submenu is left out of the extension's own
  // pages (the tutor page has its own menu, SPEC section 4.3).
  menus.onShown((shown: WebMenuShown) => {
    if (!shown.contexts.includes("selection")) return;
    const words = countWords(shown.selectionText ?? "");
    const own = shown.viewType === "tab";
    Promise.all([
      menus.update(MENU_IDS.webParent, { visible: !own }),
      menus.update(MENU_IDS.webAlternatives, { visible: words <= MAX_ALTERNATIVES_WORDS }),
    ])
      .then(() => menus.refresh())
      .catch(report("could not change the web page menu"));
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
}
