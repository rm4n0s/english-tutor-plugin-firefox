import { SystemScheduler } from "../core/clock";
import { Logger } from "../core/log";
import { CryptoRandom } from "../core/random";
import { BrowserPageModeRuntime } from "../platform/page-mode";
import { WindowPageConnector } from "../platform/page-port";
import { PageModeContent } from "./page-mode";

// The page-mode content script (SPEC section 4.11). The background script registers it only while
// page mode is on. It starts by asking whether page mode runs on this host, and does nothing if it
// does not. It never answers a `runtime` message (tutor pings are for the tutor pages).
const log = new Logger(console);

const content = new PageModeContent({
  win: window,
  runtime: new BrowserPageModeRuntime(browser),
  connector: new WindowPageConnector(window),
  scheduler: new SystemScheduler(),
  random: new CryptoRandom(),
  log,
});

content.start().catch((err: unknown) => {
  log.error("page mode could not start", { err });
});
