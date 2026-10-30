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
import { BrowserFrameActions, BrowserFrameClaim } from "../platform/page-mode";
import { WindowPagePortServer } from "../platform/page-port";
import { LinkConfirm } from "../ui/link-confirm";
import { Dialog } from "./dialog";
import { BoxExplainers } from "./explainers";
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
  // The popover and the dialog share the explanations they asked for, the confirmation of a link
  // and the one `stats-changed` announcement.
  const explainers = new BoxExplainers(
    () => new Explainer({ random: new CryptoRandom(), usage, logger: log, clock }),
  );
  const linkConfirm = new LinkConfirm(document, document.body);
  const links = new WindowLinkOpener(window);
  const statsChanged = (): void => {
    channel.post("stats-changed");
  };
  return {
    clock,
    scheduler,
    runner: new Analyzer({ random: new CryptoRandom(), usage, logger: log, clock }),
    settings,
    // A manual check of the dialog is recorded under the box's source (SPEC section 5.7).
    recorder: {
      record: (source, llmName, mistakes) => stats.record(source, llmName, mistakes),
      changed: statsChanged,
    },
    popover: new Popover({
      doc: document,
      root: document.body,
      scheduler,
      stats,
      explainers,
      linkConfirm,
      getModel: () => settings.getModel(),
      links,
      statsChanged,
      log,
    }),
    dialog: new Dialog({
      doc: document,
      root: document.body,
      scheduler,
      stats,
      explainers,
      settings,
      links,
      linkConfirm,
      actions: new BrowserFrameActions(browser),
      statsChanged,
      onStatsChanged: (listener) =>
        channel.subscribe((message) => {
          if (message.type === "stats-changed") listener();
        }),
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
