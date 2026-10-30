import { SystemClock } from "../core/clock";
import { HandoffStore } from "../core/handoff";
import { Logger } from "../core/log";
import { CryptoRandom } from "../core/random";
import { BrowserCommands } from "../platform/commands";
import { BrowserLifecycle } from "../platform/lifecycle";
import { BrowserNotifier } from "../platform/notifications";
import { BrowserOptionsOpener } from "../platform/options-page";
import { BrowserSessionStorage } from "../platform/session-storage";
import { BrowserToolbarButton } from "../platform/toolbar-button";
import { BrowserTutorTabs } from "../platform/tutor-tabs";
import { BrowserBackgroundMenus } from "../platform/web-menus";
import { startBackground, TUTOR_PAGE } from "./background";

// Every listener is registered here, synchronously, when the script starts.
startBackground({
  button: new BrowserToolbarButton(browser),
  commands: new BrowserCommands(browser),
  menus: new BrowserBackgroundMenus(browser),
  tabs: new BrowserTutorTabs(browser, TUTOR_PAGE),
  handoff: new HandoffStore(
    new BrowserSessionStorage(browser),
    new SystemClock(),
    new CryptoRandom(),
  ),
  notifier: new BrowserNotifier(browser),
  lifecycle: new BrowserLifecycle(browser),
  options: new BrowserOptionsOpener(browser),
  log: new Logger(console),
});
