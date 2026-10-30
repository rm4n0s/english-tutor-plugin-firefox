import { SystemClock, SystemScheduler } from "../core/clock";
import { HandoffStore } from "../core/handoff";
import { validateConfig } from "../core/llm";
import { Logger } from "../core/log";
import { CryptoRandom } from "../core/random";
import { openDatabase, Stats, Store } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { BrowserClipboard } from "../platform/clipboard";
import { BrowserDownloads } from "../platform/downloads";
import { WindowFragment } from "../platform/fragment";
import { SessionIgnoreSet } from "../platform/ignore-set";
import { BrowserLinkOpener } from "../platform/links";
import { BrowserContextMenus } from "../platform/menus";
import { BrowserNotifier } from "../platform/notifications";
import { BrowserOptionsOpener } from "../platform/options-page";
import { BrowserHostPermissions } from "../platform/permissions";
import { BrowserSessionStorage } from "../platform/session-storage";
import { SessionTabStorage } from "../platform/tab-storage";
import { BrowserCurrentTab } from "../platform/tabs";
import { BrowserTutorPingResponder } from "../platform/tutor-tabs";
import { mountTutor } from "./page";

const log = new Logger(console);

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new TypeError(`tutor.html has no element #${id}`);
  return found;
}

async function main(): Promise<void> {
  const clock = new SystemClock();
  const db = await openDatabase(indexedDB);
  const store = new Store(db, clock, { validateConfig });
  const stats = new Stats(db, clock, new SessionIgnoreSet(new BrowserSessionStorage(browser)));
  const options = new BrowserOptionsOpener(browser);
  const random = new CryptoRandom();
  const page = mountTutor(document, {
    store,
    stats,
    clipboard: new BrowserClipboard(navigator),
    downloads: new BrowserDownloads(browser, {
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => {
        URL.revokeObjectURL(url);
      },
    }),
    tabStorage: new SessionTabStorage(sessionStorage),
    menus: new BrowserContextMenus(browser),
    currentTab: new BrowserCurrentTab(browser),
    pageUrl: browser.runtime.getURL("tutor.html"),
    clock,
    log,
    channel: new BroadcastChangeChannel(),
    permissions: new BrowserHostPermissions(browser),
    links: new BrowserLinkOpener(browser),
    // The page's own fetch, called as a method of window.
    fetch: (input, init) => window.fetch(input, init),
    scheduler: new SystemScheduler(),
    random,
    handoff: new HandoffStore(new BrowserSessionStorage(browser), clock, random),
    fragment: new WindowFragment(window),
    notifier: new BrowserNotifier(browser),
    pingResponder: new BrowserTutorPingResponder(browser),
    openOptions: () => {
      options.open().catch((err: unknown) => {
        log.error("could not open the options page", { err });
      });
    },
  });
  window.addEventListener("pagehide", () => {
    page.destroy();
  });
  await page.ready;
  // A hand-off may have put the focus in the Alternatives panel already.
  if (document.activeElement === null || document.activeElement === document.body) {
    element("editor").focus();
  }
  log.debug("tutor page ready");
}

main().catch((err: unknown) => {
  log.error("tutor page failed to start", { err });
  const banner = document.createElement("p");
  banner.className = "banner";
  banner.setAttribute("role", "alert");
  banner.textContent = "The tutor page could not open its database. Reload the page to try again.";
  document.querySelector(".editor-pane")?.prepend(banner);
});
