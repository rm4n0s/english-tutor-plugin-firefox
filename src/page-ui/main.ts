import { Analyzer } from "../core/analysis";
import { SystemClock, SystemScheduler } from "../core/clock";
import { validateConfig } from "../core/llm";
import { Logger } from "../core/log";
import { frameIdOfFragment } from "../core/page-mode/protocol";
import { CryptoRandom } from "../core/random";
import { openDatabase, Store, StoreUsageRecorder } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { BrowserFrameClaim } from "../platform/page-mode";
import { WindowPagePortServer } from "../platform/page-port";
import { PageFrame, type FrameServices } from "./frame";
import { AllUrlsPermissions } from "./permissions";
import { FrameSettings } from "./settings";

// The page-mode frame (SPEC section 4.11): an extension page inside a web page. The content
// script made the address's fragment: the id of the one port this frame accepts.
const log = new Logger(console);

async function openServices(): Promise<FrameServices> {
  const clock = new SystemClock();
  const db = await openDatabase(indexedDB);
  const store = new Store(db, clock, { validateConfig });
  const settings = new FrameSettings({
    store,
    permissions: new AllUrlsPermissions(),
    // The page's own fetch, called as a method of window.
    fetch: (input, init) => window.fetch(input, init),
    channel: new BroadcastChangeChannel(),
  });
  await settings.load();
  return {
    clock,
    scheduler: new SystemScheduler(),
    runner: new Analyzer({
      random: new CryptoRandom(),
      usage: new StoreUsageRecorder(store),
      logger: log,
      clock,
    }),
    settings,
  };
}

const id = frameIdOfFragment(window.location.hash);
if (id !== undefined) {
  // Registered now, synchronously: the content script connects as soon as this frame has loaded.
  new PageFrame({
    id,
    server: new WindowPagePortServer(window),
    claim: new BrowserFrameClaim(browser),
    services: openServices(),
    log,
  });
}
