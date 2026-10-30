import type { Clock, Scheduler } from "../core/clock";
import type { HandoffStore } from "../core/handoff";
import type { Logger } from "../core/log";
import type { Random } from "../core/random";
import type { Stats, Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { Clipboard } from "../platform/clipboard";
import type { PageFragment } from "../platform/fragment";
import type { LinkOpener } from "../platform/links";
import type { Downloads } from "../platform/downloads";
import type { ContextMenus } from "../platform/menus";
import type { Notifier } from "../platform/notifications";
import type { HostPermissions } from "../platform/permissions";
import type { TabStorage } from "../platform/tab-storage";
import type { CurrentTab } from "../platform/tabs";
import type { TutorPingResponder } from "../platform/tutor-tabs";

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
  /** Copy in the Alternatives panel. */
  clipboard: Clipboard;
  /** Save and Save As write the text to a file by downloading it (SPEC section 8). */
  downloads: Downloads;
  /** The tab's `sessionStorage`, where the text and its state are kept for a reload. */
  tabStorage: TabStorage;
  /** The context menus of the row of the issues list and of the editor. */
  menus: ContextMenus;
  /** The tab this page is in, to tell menu events for this tab from the others. */
  currentTab: CurrentTab;
  /** The address of `tutor.html`, which the menu entries are limited to. */
  pageUrl: string;
  /** The text a web page menu entry handed over (SPEC section 4.1). */
  handoff: HandoffStore;
  /** The address fragment, where a hand-off names its entry. */
  fragment: PageFragment;
  /** The check-finished notification (SPEC section 4.10). */
  notifier: Notifier;
  /** Lets the background script find this tab and ask whether it has unsaved changes. */
  pingResponder: TutorPingResponder;
  /** Opens the options page (the Prefs button, and the link in the no-LLM hint). */
  openOptions(): void;
}
