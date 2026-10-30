import { SystemClock, SystemScheduler } from "../core/clock";
import { validateConfig } from "../core/llm";
import { Logger } from "../core/log";
import { CryptoRandom } from "../core/random";
import { openDatabase, Store } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { BrowserOptionsOpener } from "../platform/options-page";
import { BrowserHostPermissions } from "../platform/permissions";
import { attachDivider } from "../ui/divider";
import { mountTutor } from "./page";

const log = new Logger(console);

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new TypeError(`tutor.html has no element #${id}`);
  return found;
}

// The two draggable dividers. Their positions are remembered in step 12.
attachDivider(element("divider-main"), {
  container: element("panes"),
  axis: "x",
  property: "--editor-share",
  min: 30,
  max: 85,
});
attachDivider(element("divider-side"), {
  container: element("side"),
  axis: "y",
  property: "--issues-share",
  min: 15,
  max: 85,
});

async function main(): Promise<void> {
  const clock = new SystemClock();
  const db = await openDatabase(indexedDB);
  const store = new Store(db, clock, { validateConfig });
  const options = new BrowserOptionsOpener(browser);
  const page = mountTutor(document, {
    store,
    clock,
    log,
    channel: new BroadcastChangeChannel(),
    permissions: new BrowserHostPermissions(browser),
    // The page's own fetch, called as a method of window.
    fetch: (input, init) => window.fetch(input, init),
    scheduler: new SystemScheduler(),
    random: new CryptoRandom(),
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
  element("editor").focus();
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
