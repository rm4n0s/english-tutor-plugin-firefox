import { SystemClock, SystemScheduler } from "../core/clock";
import { Logger } from "../core/log";
import { CryptoRandom } from "../core/random";
import { BrowserPageModeRuntime } from "../platform/page-mode";
import { WindowPageConnector } from "../platform/page-port";
import { PageModeContent } from "./page-mode";
import { claimPageSlot } from "./slot";

// The page-mode content script (SPEC section 4.11). The manifest declares it for every http(s) page
// and frame (LanguageTool's model), and the background script also runs it in the tabs that were
// open at the installation. It starts by asking what page mode does on this host: on a site that
// is on it checks the text boxes the user focuses, on a site with no choice it shows the dimmed
// icon, and on any other (or when the switch is off, or access to the site is gone) it does
// nothing. It never answers a `runtime` message (tutor pings are for the tutor pages).
const log = new Logger(console);

// Once per page frame: the background script also runs this file in the tabs that were open at the
// installation or the update, and a page can end up with both copies.
if (claimPageSlot(globalThis)) {
  const content = new PageModeContent({
    win: window,
    runtime: new BrowserPageModeRuntime(browser),
    connector: new WindowPageConnector(window),
    scheduler: new SystemScheduler(),
    clock: new SystemClock(),
    random: new CryptoRandom(),
    log,
  });

  content.start().catch((err: unknown) => {
    log.error("page mode could not start", { err });
  });
}
