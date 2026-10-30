import { SystemClock } from "../core/clock";
import { HandoffStore } from "../core/handoff";
import { Logger } from "../core/log";
import { FrameClaims } from "../core/page-mode/frame-claims";
import { validateConfig } from "../core/llm";
import { CryptoRandom } from "../core/random";
import { openDatabase, Store } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { BrowserCommands } from "../platform/commands";
import { BrowserLifecycle } from "../platform/lifecycle";
import { BrowserNotifier } from "../platform/notifications";
import { BrowserOptionsOpener } from "../platform/options-page";
import {
  BrowserBackgroundMessages,
  BrowserContentScripts,
  BrowserPageModePermission,
  BrowserPageTabs,
} from "../platform/page-mode";
import { SessionIgnoreSet } from "../platform/ignore-set";
import { BrowserSessionStorage } from "../platform/session-storage";
import { BrowserToolbarButton } from "../platform/toolbar-button";
import { BrowserTutorTabs } from "../platform/tutor-tabs";
import { BrowserBackgroundMenus } from "../platform/web-menus";
import { startBackground, TUTOR_PAGE } from "./background";
import { PageModeBackend } from "./page-mode";

/**
 * Opens the store the first time something needs it. The connection closes itself when another
 * page upgrades or deletes the database, or when the browser drops it; the next call opens it again.
 */
class LazyStore {
  private opened: Promise<Store> | undefined;

  get(): Promise<Store> {
    this.opened ??= openDatabase(indexedDB).then((db) => {
      const forget = (): void => {
        this.opened = undefined;
      };
      db.addEventListener("versionchange", forget);
      db.addEventListener("close", forget);
      return new Store(db, new SystemClock(), { validateConfig });
    });
    this.opened.catch(() => {
      this.opened = undefined;
    });
    return this.opened;
  }
}

const log = new Logger(console);
const lazyStore = new LazyStore();
const permission = new BrowserPageModePermission(browser);
const session = new BrowserSessionStorage(browser);

// Every listener is registered here, synchronously, when the script starts.
startBackground({
  button: new BrowserToolbarButton(browser),
  commands: new BrowserCommands(browser),
  menus: new BrowserBackgroundMenus(browser),
  tabs: new BrowserTutorTabs(browser, TUTOR_PAGE),
  handoff: new HandoffStore(session, new SystemClock(), new CryptoRandom()),
  notifier: new BrowserNotifier(browser),
  lifecycle: new BrowserLifecycle(browser),
  options: new BrowserOptionsOpener(browser),
  pageMode: new PageModeBackend({
    settings: () => lazyStore.get(),
    permission,
    scripts: new BrowserContentScripts(browser),
    tabs: new BrowserPageTabs(browser),
    session,
    channel: new BroadcastChangeChannel(),
    log,
  }),
  frameClaims: new FrameClaims(session, new SystemClock()),
  ignore: new SessionIgnoreSet(session),
  permission,
  messages: new BrowserBackgroundMessages(browser),
  log,
});
