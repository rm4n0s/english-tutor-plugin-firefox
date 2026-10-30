import type { Clock, Scheduler } from "../core/clock";
import type { Logger } from "../core/log";
import type { Random } from "../core/random";
import type { Stats, Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { LinkOpener } from "../platform/links";
import type { ContextMenus } from "../platform/menus";
import type { HostPermissions } from "../platform/permissions";
import type { CurrentTab } from "../platform/tabs";

/** Everything the tutor page needs from outside, so tests can pass fakes. */
export interface TutorDeps {
  store: Store;
  /** Mistakes and token usage: recording, counts, Not an error and the Statistics dialog. */
  stats: Stats;
  channel: ChangeChannel;
  permissions: HostPermissions;
  /** The page's `fetch`. */
  fetch: typeof fetch;
  clock: Clock;
  scheduler: Scheduler;
  /** The source of delimiter tokens of the check prompt and of the tab's source key. */
  random: Random;
  log: Logger;
  /** Opens a link of an explanation in a new tab next to this one. */
  links: LinkOpener;
  /** The context menus of the row of the issues list (and, from step 10, of the editor). */
  menus: ContextMenus;
  /** The tab this page is in, to tell menu events for this tab from the others. */
  currentTab: CurrentTab;
  /** The address of `tutor.html`, which the menu entries are limited to. */
  pageUrl: string;
  /** Opens the options page (the Prefs button, and the link in the no-LLM hint). */
  openOptions(): void;
}
