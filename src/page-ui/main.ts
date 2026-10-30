import { Analyzer, Explainer } from "../core/analysis";
import { SystemClock, SystemScheduler } from "../core/clock";
import { validateConfig } from "../core/llm";
import { Logger } from "../core/log";
import { frameIdOfFragment } from "../core/page-mode/protocol";
import { CryptoRandom } from "../core/random";
import { openDatabase, Stats, Store, StoreUsageRecorder } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { RuntimeIgnoreSet } from "../platform/ignore-set";
import { WindowLinkOpener } from "../platform/links";
import { BrowserFrameClaim } from "../platform/page-mode";
import { WindowPagePortServer } from "../platform/page-port";
import { PageFrame, type FrameServices } from "./frame";
import { AllUrlsPermissions } from "./permissions";
import { Popover } from "./popover";
import { FrameSettings } from "./settings";

// The page-mode frame (SPEC section 4.11): an extension page inside a web page. The content
// script made the address's fragment: the id of the one port this frame accepts.
const log = new Logger(console);

async function openServices(): Promise<FrameServices> {
  const clock = new SystemClock();
  const db = await openDatabase(indexedDB);
  const store = new Store(db, clock, { validateConfig });
  const channel = new BroadcastChangeChannel();
  const settings = new FrameSettings({
    store,
    permissions: new AllUrlsPermissions(),
    // The page's own fetch, called as a method of window.
    fetch: (input, init) => window.fetch(input, init),
    channel,
  });
  await settings.load();
  const scheduler = new SystemScheduler();
  const usage = new StoreUsageRecorder(store);
  // Not an error shares the editor's ignore set (SPEC section 5.7). The frame has no
  // `storage.session` (Firefox 159), so the background script keeps the set for it.
  const stats = new Stats(db, clock, new RuntimeIgnoreSet(browser.runtime));
  return {
    clock,
    scheduler,
    runner: new Analyzer({ random: new CryptoRandom(), usage, logger: log, clock }),
    settings,
    popover: new Popover({
      doc: document,
      root: document.body,
      scheduler,
      stats,
      newExplainer: () => new Explainer({ random: new CryptoRandom(), usage, logger: log, clock }),
      getModel: () => settings.getModel(),
      links: new WindowLinkOpener(window),
      statsChanged: () => {
        channel.post("stats-changed");
      },
      log,
    }),
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
