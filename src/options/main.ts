import { SystemClock } from "../core/clock";
import { Logger } from "../core/log";
import { validateConfig } from "../core/llm";
import { openDatabase, Store } from "../core/store";
import { BroadcastChangeChannel } from "../platform/channel";
import { BrowserPageModeBackendLink, BrowserPageModePermission } from "../platform/page-mode";
import { BrowserHostPermissions } from "../platform/permissions";
import { mountOptions } from "./page";

const log = new Logger(console);

async function main(): Promise<void> {
  const clock = new SystemClock();
  const db = await openDatabase(indexedDB);
  const store = new Store(db, clock, { validateConfig });
  const page = mountOptions(document, {
    store,
    clock,
    log,
    channel: new BroadcastChangeChannel(),
    permissions: new BrowserHostPermissions(browser),
    pageMode: new BrowserPageModePermission(browser),
    background: new BrowserPageModeBackendLink(browser),
    // The page's own fetch, called as a method of window.
    fetch: (input, init) => window.fetch(input, init),
  });
  window.addEventListener("pagehide", () => {
    page.destroy();
  });
  await page.ready;
  log.debug("options page ready");
}

main().catch((err: unknown) => {
  log.error("options page failed to start", { err });
  const banner = document.createElement("p");
  banner.className = "banner";
  banner.setAttribute("role", "alert");
  banner.textContent =
    "The options page could not open its database. Reload the page to try again.";
  document.querySelector(".page")?.prepend(banner);
});
